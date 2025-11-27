
import { MODELS, HOURLY_VARS, BASE_VARS, FULL_VARS, LIMITED_VARS, parseUTC, FORECAST_VARIABLES, VERIFICATION_VARIABLES, LEAD_TIME_BUCKETS, LOCATION, MIN_MAE_THRESHOLDS, MISSING_DATA_PENALTY_SCORE, isVariableSupported, CHECKWX_API_KEY } from '../constants';
import type { Forecast, Observation, Verification, BucketName, ModelVariableStats, LeaderboardRow } from '../types';
import * as db from './db';

type LogFn = (message: string) => void;

let log: LogFn = (message: string) => console.log(message);
export const setLogger = (logger: LogFn) => {
    log = logger;
}

// Robust fetch with exponential backoff
const fetchWithRetry = async (url: string, retries = 3, delay = 1000): Promise<Response> => {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (res.status === 429 || res.status >= 500) {
                throw new Error(`HTTP ${res.status}`);
            }
            if (!res.ok) {
                return res;
            }
            return res;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
        }
    }
    throw new Error('Max retries reached');
};

/**
 * Fetches "Hybrid" ground truth data from Open-Meteo Reanalysis/Analysis.
 */
async function fetchHybridGroundTruth(): Promise<Record<number, Partial<Observation>>> {
    log('[HYBRID] Fetching ERA5/Reanalysis ground truth for gaps...');
    // Increased forecast_days to 2 to ensure we get the current hour even if late in the day (UTC offset issues)
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}&past_days=3&forecast_days=2&hourly=temperature_2m,dew_point_2m,pressure_msl,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code&timezone=UTC`;

    try {
        const response = await fetchWithRetry(url, 2, 500);
        const data = await response.json();

        if (!data || !data.hourly || !data.hourly.time) {
            return {};
        }

        const hybridMap: Record<number, Partial<Observation>> = {};
        const now = Date.now();

        data.hourly.time.forEach((t: string, i: number) => {
            const time = parseUTC(t);
            // Allow up to 1 hour into the future for "current conditions" fill
            if (time > now + 3600000) return;

            hybridMap[time] = {
                temperature: data.hourly.temperature_2m?.[i] ?? null,
                dewpoint: data.hourly.dew_point_2m?.[i] ?? null,
                pressure_msl: data.hourly.pressure_msl?.[i] ?? null, // Keep as hPa
                wind_speed: data.hourly.wind_speed_10m?.[i] ?? null, // Keep as km/h
                wind_dir: data.hourly.wind_direction_10m?.[i] ?? null,
                era_precip_amt: data.hourly.precipitation?.[i] ?? null,
                era_rain_amt: data.hourly.rain?.[i] ?? null,
                era_snow_amt: data.hourly.snowfall?.[i] ?? null,
                era_wind_gust: data.hourly.wind_gusts_10m?.[i] ?? null, // Keep as km/h
            };
        });

        log(`[HYBRID] Retrieved ${Object.keys(hybridMap).length} hours of reanalysis data.`);
        return hybridMap;

    } catch (e) {
        log(`[HYBRID] Failed to fetch reanalysis data: ${e}`);
        return {};
    }
}

// Helper for CheckWX Fetching
async function fetchCheckWX(endpoint: string): Promise<any> {
    const url = `https://api.checkwx.com/${endpoint}`;
    const res = await fetch(url, {
        headers: { 'X-API-Key': CHECKWX_API_KEY }
    });
    if (!res.ok) throw new Error(`CheckWX HTTP ${res.status}`);
    return res.json();
}

export async function fetchTAF(): Promise<string | null> {
    try {
        const data = await fetchCheckWX(`taf/${LOCATION.name}/decoded`);
        if (data && data.data && data.data.length > 0) {
            return data.data[0].raw_text || null;
        }
    } catch (e) {
        log(`[TAF] Failed to fetch TAF: ${e}`);
    }
    return null;
}

export async function fetchMETARHistory(): Promise<Observation[]> {
    log('[METAR] Fetching last 48 hours of observations...');

    // Clear old observations to remove stale synthetic records
    await db.clearTable('observations');

    let rawMetars: any[] = [];
    let source = '';

    // --- 5 LAYERS OF FALLBACK ---
    const layers = [
        {
            name: 'Layer 1: CheckWX (Decoded)',
            fn: async () => {
                const data = await fetchCheckWX(`metar/${LOCATION.name}/decoded?hours=48`);
                return data.data;
            }
        },
        {
            name: 'Layer 2: CheckWX (Raw)',
            fn: async () => {
                const data = await fetchCheckWX(`metar/${LOCATION.name}?hours=48`);
                // CheckWX raw returns strings, we need objects to map later. 
                // This is a weak fallback if decoded fails, but useful connectivity check.
                return data.data.map((raw: string) => ({ raw_text: raw, station: { name: LOCATION.name } }));
            }
        },
        {
            name: 'Layer 3: AviationWeather.gov (JSON)',
            fn: async () => {
                const res = await fetchWithRetry(`https://aviationweather.gov/api/data/metar?ids=${LOCATION.name}&format=json&hours=48`, 2, 500);
                if (!res.ok) throw new Error(`AviationWeather HTTP ${res.status}`);
                return res.json();
            }
        },
        {
            name: 'Layer 4: CORS Proxy -> AviationWeather',
            fn: async () => {
                const target = `https://aviationweather.gov/api/data/metar?ids=${LOCATION.name}&format=json&hours=48`;
                const res = await fetchWithRetry(`https://corsproxy.io/?${encodeURIComponent(target)}`, 2, 1000);
                if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
                return res.json();
            }
        },
        {
            name: 'Layer 5: AllOrigins -> AviationWeather',
            fn: async () => {
                const target = `https://aviationweather.gov/api/data/metar?ids=${LOCATION.name}&format=json&hours=48`;
                const res = await fetchWithRetry(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`, 2, 1000);
                if (!res.ok) throw new Error(`AllOrigins HTTP ${res.status}`);
                return res.json();
            }
        }
    ];

    for (const layer of layers) {
        try {
            log(`[METAR] Attempting ${layer.name}...`);
            const result = await layer.fn();
            // Require at least 20 records to consider it successful (covers ~24-48 hours with SPECIs)
            if (Array.isArray(result) && result.length >= 20) {
                rawMetars = result;
                source = layer.name;
                log(`[METAR] Success via ${layer.name} (${result.length} records)`);
                break;
            } else if (Array.isArray(result) && result.length > 0) {
                log(`[METAR] ${layer.name} returned insufficient data (${result.length} records, need ≥20). Trying next layer...`);
            } else {
                log(`[METAR] ${layer.name} returned empty data.`);
            }
        } catch (e) {
            log(`[METAR] ${layer.name} Failed: ${e}`);
        }
    }

    if (rawMetars.length === 0) {
        log('[METAR] CRITICAL: All 5 layers failed to fetch METAR data.');
        throw new Error('CRITICAL_METAR_FAILURE');
    }

    const hybridData = await fetchHybridGroundTruth();
    const observations: Observation[] = [];
    const now = Date.now();
    const currentHour = Math.floor(now / 3600000) * 3600000;

    const parseNum = (val: any): number | null => {
        if (val === null || val === undefined) return null;
        const n = parseFloat(val);
        return isFinite(n) ? n : null;
    };

    const metarGroups: Record<number, any[]> = {};

    // Group by hour
    rawMetars.forEach((metar: any) => {
        let obsTimeEpoch: number = 0;
        let rawText = '';

        // CheckWX Format
        if (metar.observed) {
            obsTimeEpoch = parseUTC(metar.observed);
            rawText = metar.raw_text || '';
        }
        // AviationWeather Format
        else if (metar.obsTime || metar.obstime) {
            const t = metar.obsTime || metar.obstime;
            obsTimeEpoch = typeof t === 'number' ? t * 1000 : parseUTC(t);
            rawText = metar.rawOb || metar.raw_text || '';
        }

        if (obsTimeEpoch > 0) {
            const alignedHour = Math.round(obsTimeEpoch / 3600000) * 3600000;
            if (!metarGroups[alignedHour]) metarGroups[alignedHour] = [];
            metarGroups[alignedHour].push({ ...metar, exactTime: obsTimeEpoch, _raw: rawText });
        }
    });

    for (let i = 0; i < 48; i++) {
        const targetTime = currentHour - (i * 3600000);
        const group = metarGroups[targetTime];
        const era = hybridData[targetTime];

        // POLICY: 
        // 1. METAR is the ONLY source for "Observation Existence". If METAR is missing, we do NOT fill with ERA5.
        // 2. ERA5 is used ONLY to provide precipitation AMOUNTS (mm/cm) for existing METARs, as METARs lack this.

        // STRICT: If no real METAR exists, do NOT create a synthetic one.
        if ((!group || group.length === 0)) continue;

        // Select BEST report for continuous variables (closest to targetTime)
        const best = group.reduce((prev, curr) =>
            Math.abs(curr.exactTime - targetTime) < Math.abs(prev.exactTime - targetTime) ? curr : prev
        );

        const rawText = best._raw;

        // Parsing Logic (Unified)
        let temp = best.temperature?.celsius ?? best.temp ?? null;
        let dewp = best.dewpoint?.celsius ?? best.dewp ?? null;
        let wdir = best.wind?.degrees ?? best.wdir ?? null;
        let wspdKts = best.wind?.speed_kts ?? best.wspd ?? null;
        let wgstKts = best.wind?.gust_kts ?? best.wgst ?? null;
        let wspd = wspdKts !== null ? wspdKts * 1.852 : null; // Convert Kts to km/h
        let wgst = wgstKts !== null ? wgstKts * 1.852 : null; // Convert Kts to km/h

        let visib = best.visibility?.meters_float ?? (best.visib ? best.visib * 1609.34 : null);

        // Pressure: Prefer mb/hPa, fallback to inHg and convert
        let pressureHpa = best.barometer?.mb ?? null;
        if (pressureHpa === null) {
            // CheckWX uses barometer.hg (inHg). AviationWeather uses altim (could be inHg or hPa depending on API version/config)
            // Heuristic: If value > 800, it's hPa. If < 100, it's inHg.
            const rawAltim = best.barometer?.hg ?? best.altim ?? null;
            if (rawAltim !== null) {
                if (rawAltim > 800) {
                    pressureHpa = rawAltim; // Already hPa
                } else {
                    pressureHpa = rawAltim * 33.8639; // Convert inHg to hPa
                }
            }
        }
        let pressure = pressureHpa;

        // Ceiling (from best report)
        let ceilingAgl: number | null = null;
        const clouds = best.clouds || [];
        if (Array.isArray(clouds)) {
            for (const layer of clouds) {
                const cover = layer.code || layer.cover;
                const baseFt = layer.base_feet_agl || layer.base;
                if (['BKN', 'OVC', 'VV'].includes(cover) && baseFt != null) {
                    ceilingAgl = baseFt * 0.3048;
                    break;
                }
            }
        }

        // Precip (from best report)
        let precipMm: number | null = null;
        if (rawText.includes('P0000')) precipMm = 0;

        // AGGREGATE WEATHER CODES from ALL reports in the hour
        const weatherCodes = new Set<string>();
        group.forEach(report => {
            const txt = report._raw || '';

            // Freezing Precip
            if (/(^|\s)(FZRA|FZDZ|FZFG)(\s|$)/.test(txt)) weatherCodes.add('FZRA');

            // Rain (including mixed RASN, TSRA, SHRA)
            // Matches: RA, DZ, SHRA, TSRA, RASN, SNRA
            if (/(^|\s)(-|\+)?(RA|DZ|SHRA|TSRA|RASN|SNRA)(\s|$)/.test(txt) && !/(^|\s)(FZRA|FZDZ)(\s|$)/.test(txt)) weatherCodes.add('RA');

            // Snow (including mixed RASN, SNRA)
            // Matches: SN, SG, SHSN, BLSN, RASN|SNRA
            if (/(^|\s)(-|\+)?(SN|SG|SHSN|BLSN|RASN|SNRA)(\s|$)/.test(txt)) weatherCodes.add('SN');

            // Thunderstorm
            if (/(^|\s)(TS|TSRA)(\s|$)/.test(txt)) weatherCodes.add('TS');
        });

        // Check for Variable Wind (VRB)
        const isVariableWind = /(^|\s)VRB\d{2}(KT|MPS|KMH)(\s|$)/.test(rawText);

        const obs: Observation = {
            obs_time: targetTime,
            report_type: group.length > 1 ? `METAR+${group.length - 1}SPECI` : (rawText.includes('SPECI') ? 'SPECI' : 'METAR'),
            temperature: parseNum(temp),
            dewpoint: parseNum(dewp),
            wind_dir: parseNum(wdir),
            wind_variable: isVariableWind,
            wind_speed: parseNum(wspd),
            wind_gust: parseNum(wgst),
            visibility: parseNum(visib),
            pressure_msl: parseNum(pressure),
            raw_text: rawText,
            precip_1h: precipMm,
            ceiling_agl: ceilingAgl,
            weather_codes: Array.from(weatherCodes),
            era_precip_amt: era?.era_precip_amt ?? null,
            era_rain_amt: era?.era_rain_amt ?? null,
            era_snow_amt: era?.era_snow_amt ?? null,
            era_wind_gust: era?.era_wind_gust ?? null
        };

        observations.push(obs);
    }

    if (observations.length > 0) {
        await db.bulkPut('observations', observations);
        log(`[METAR] Stored ${observations.length} observations (Source: ${source})`);
        return observations;
    }
    return [];
}

async function storeForecast(modelId: string, apiModel: string | undefined, data: any, issueTime: number): Promise<void> {
    const times = data.hourly.time;
    const forecasts: Forecast[] = [];

    const getVal = (baseName: string, index: number): number | null => {
        // 1. Try exact match
        let val = data.hourly[baseName]?.[index];

        // DEBUG LOGGING FOR FIRST ITEM ONLY
        if (index === 0 && baseName === 'temperature_2m') {
            log(`[DEBUG-VAL] ${modelId} | base: ${baseName} | apiModel: ${apiModel}`);
            log(`[DEBUG-VAL] exact match: ${val}`);
        }

        if (val !== undefined && val !== null) return Number.isFinite(val) ? val : null;

        // 2. Try with apiModel suffix (e.g. temperature_2m_ecmwf_aifs025)
        if (apiModel) {
            val = data.hourly[`${baseName}_${apiModel}`]?.[index];
            if (index === 0 && baseName === 'temperature_2m') log(`[DEBUG-VAL] suffixed (${baseName}_${apiModel}): ${val}`);
            if (val !== undefined && val !== null) return Number.isFinite(val) ? val : null;
        }

        // 3. Try finding ANY key that starts with baseName (Desperate fallback for suffixed vars)
        const matchingKey = Object.keys(data.hourly).find(k => k.startsWith(baseName + '_'));
        if (matchingKey) {
            val = data.hourly[matchingKey]?.[index];
            if (index === 0 && baseName === 'temperature_2m') log(`[DEBUG-VAL] fuzzy match (${matchingKey}): ${val}`);
            if (val !== undefined && val !== null) return Number.isFinite(val) ? val : null;
        }

        return null;
    };

    const now = Date.now();

    for (let i = 0; i < times.length; i++) {
        const validTime = parseUTC(times[i]);
        let recordIssueTime = issueTime;

        // STRICT FORECAST LOGIC:
        // We only store data where validTime >= issueTime.
        // We DO NOT backfill past data as "forecasts" because that is analysis data (hindcast),
        // not a true prediction made in the past.
        if (validTime < issueTime) {
            continue;
        }

        // recordIssueTime is always the actual fetch time (rounded to hour)
        // (No change needed, it was initialized to issueTime above)

        const temp = getVal('temperature_2m', i);
        if (temp === null) continue;

        let precip = getVal('precipitation', i);
        let rain = getVal('rain', i);
        let showers = getVal('showers', i);
        let snowfall = getVal('snowfall', i);

        if (precip === 0) {
            if (rain === null) rain = 0;
            if (showers === null) showers = 0;
            if (snowfall === null) snowfall = 0;
        }

        const record: Forecast = {
            id: `${modelId}_${recordIssueTime}_${validTime}`,
            model_id: modelId,
            issue_time: recordIssueTime,
            valid_time: validTime,
            temperature_2m: temp,
            dew_point_2m: getVal('dew_point_2m', i),
            wind_speed_10m: getVal('wind_speed_10m', i),
            wind_direction_10m: getVal('wind_direction_10m', i),
            wind_gusts_10m: getVal('wind_gusts_10m', i),
            pressure_msl: getVal('pressure_msl', i),
            visibility: getVal('visibility', i),
            relative_humidity_2m: getVal('relative_humidity_2m', i),
            apparent_temperature: getVal('apparent_temperature', i),
            precipitation: precip,
            snowfall: snowfall,
            snow_depth: getVal('snow_depth', i),
            rain: rain,
            showers: showers,
            weather_code: getVal('weather_code', i),
            cloud_cover: getVal('cloud_cover', i),
            cloud_cover_low: getVal('cloud_cover_low', i),
            cloud_cover_mid: getVal('cloud_cover_mid', i),
            cloud_cover_high: getVal('cloud_cover_high', i),
            cape: getVal('cape', i),
            precipitation_probability: getVal('precipitation_probability', i),
            cloud_base_agl: getVal('cloud_base_agl', i)
        };
        forecasts.push(record);
    }
    await db.bulkPut('forecasts', forecasts);
    if (forecasts.length > 0) {
        log(`[STORE] ${modelId}: Stored ${forecasts.length} forecast hours`);
    } else {
        log(`[STORE] ${modelId}: Warning - 0 hours stored. (Missing Temp?)`);

        // DIAGNOSTIC: Check if ANY valid temp exists in the raw data
        const rawTemps = data.hourly['temperature_2m'] || [];
        const validCount = rawTemps.filter((v: any) => v !== null).length;
        log(`[DEBUG] ${modelId}: Found ${validCount} valid temps out of ${rawTemps.length} total slots.`);

        if (validCount === 0) {
            // Check suffixed vars
            const keys = Object.keys(data.hourly).filter(k => k.startsWith('temperature_2m_'));
            keys.forEach(k => {
                const count = (data.hourly[k] || []).filter((v: any) => v !== null).length;
                log(`[DEBUG] ${modelId} (${k}): ${count} valid values`);
            });
        }
    }
}

async function generateSyntheticModels(issueTime: number): Promise<void> {
    log(`[SYNTHETIC] Generating Average/Median for issue time ${new Date(issueTime).toISOString()}...`);

    const startValid = issueTime - (48 * 3600 * 1000);
    const endValid = issueTime + (10 * 24 * 3600 * 1000);

    const relevantForecasts: Forecast[] = await db.getAll('forecasts', 'by_valid_time', IDBKeyRange.bound(startValid, endValid));
    const validTimeGroups: Record<number, Forecast[]> = {};

    relevantForecasts.forEach(f => {
        if (f.model_id.includes('_of_models')) return;
        if (!validTimeGroups[f.valid_time]) validTimeGroups[f.valid_time] = [];
        validTimeGroups[f.valid_time].push(f);
    });

    const syntheticForecasts: Forecast[] = [];
    for (const [validTimeStr, forecasts] of Object.entries(validTimeGroups)) {
        const vt = parseInt(validTimeStr, 10);
        if (forecasts.length < 2) continue;

        const representativeIssueTime = forecasts[0].issue_time;

        const avgRecord: Partial<Forecast> = {
            id: `average_of_models_${representativeIssueTime}_${vt}`,
            model_id: 'average_of_models',
            issue_time: representativeIssueTime,
            valid_time: vt
        };
        const medRecord: Partial<Forecast> = {
            id: `median_of_models_${representativeIssueTime}_${vt}`,
            model_id: 'median_of_models',
            issue_time: representativeIssueTime,
            valid_time: vt
        };

        for (const varName of FORECAST_VARIABLES) {
            const values = forecasts
                .map(f => f[varName as keyof Forecast])
                .filter(v => v !== null && v !== undefined && Number.isFinite(v as number)) as number[];

            if (values.length > 0) {
                if (varName === 'wind_direction_10m') {
                    let sumSin = 0;
                    let sumCos = 0;
                    values.forEach(deg => {
                        const rad = deg * (Math.PI / 180);
                        sumSin += Math.sin(rad);
                        sumCos += Math.cos(rad);
                    });
                    let avgDeg = Math.atan2(sumSin, sumCos) * (180 / Math.PI);
                    if (avgDeg < 0) avgDeg += 360;
                    (avgRecord as any)[varName] = avgDeg;

                    const deviations = values.map(deg => {
                        let diff = deg - avgDeg;
                        while (diff <= -180) diff += 360;
                        while (diff > 180) diff -= 360;
                        return { deg, diff: Math.abs(diff) };
                    });
                    deviations.sort((a, b) => a.diff - b.diff);
                    (medRecord as any)[varName] = deviations[0].deg;

                } else {
                    const sum = values.reduce((a, b) => a + b, 0);
                    (avgRecord as any)[varName] = (sum / values.length);
                    const sorted = [...values].sort((a, b) => a - b);
                    const mid = Math.floor(sorted.length / 2);
                    (medRecord as any)[varName] = (sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]);
                }
            } else {
                (avgRecord as any)[varName] = null;
                (medRecord as any)[varName] = null;
            }
        }
        syntheticForecasts.push(avgRecord as Forecast, medRecord as Forecast);
    }
    await db.bulkPut('forecasts', syntheticForecasts);
    log(`[SYNTHETIC] Generated ${syntheticForecasts.length / 2} hours for Average and Median models`);
}

export async function fetchAllModels() {
    const commonIssueTime = Math.floor(Date.now() / 3600000) * 3600000;

    log(`[FETCH] Starting model fetch. Anchor Time: ${new Date(commonIssueTime).toISOString()}`);
    const BATCH_SIZE = 4;

    // Helper to determine fallback model ID
    const getFallbackModel = (configId: string): string => {
        if (configId.includes('gfs')) return 'gfs_seamless';
        if (configId.includes('gem')) return 'gem_global';
        return 'ecmwf_ifs04'; // Default stable fallback
    };

    for (let i = 0; i < MODELS.length; i += BATCH_SIZE) {
        const batch = MODELS.slice(i, i + BATCH_SIZE);
        log(`[FETCH] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}...`);

        const batchPromises = batch.map(async (config) => {
            // Helper: Get model name variants to try
            const getModelVariants = (apiModel: string | undefined, providerId: string): string[] => {
                if (!apiModel) return ['default'];

                const variants: string[] = [apiModel];

                // Try seamless variant
                if (apiModel.includes('_global')) {
                    variants.push(apiModel.replace('_global', '_seamless'));
                }
                if (!apiModel.includes('seamless')) {
                    const base = apiModel.split('_')[0];
                    variants.push(`${base}_seamless`);
                }

                // Try without suffix
                if (apiModel.match(/\d{2,3}$/)) {
                    variants.push(apiModel.replace(/\d{2,3}$/, ''));
                }

                // Try with underscores instead of numbers attached
                if (apiModel.includes('025')) {
                    variants.push(apiModel.replace('025', '_025'));
                }
                if (apiModel.includes('04')) {
                    variants.push(apiModel.replace('04', '_04').replace('ifs_04', 'ifs04'));
                }

                return [...new Set(variants)];
            };

            const modelVariants = getModelVariants(config.apiModel, config.provider);

            // 5 Layers: Try different model name variants and variable combinations
            const layers = [
                {
                    name: `Layer 1: ${config.apiModel || 'default'} + Config Vars`,
                    vars: config.vars || FULL_VARS,
                    model: config.apiModel
                },
                {
                    name: `Layer 2: ${config.apiModel || 'default'} + BASE_VARS`,
                    vars: BASE_VARS,
                    model: config.apiModel
                },
                {
                    name: `Layer 3: ${modelVariants[1] || config.apiModel} (variant) + LIMITED_VARS`,
                    vars: LIMITED_VARS,
                    model: modelVariants[1] || config.apiModel
                },
                {
                    name: `Layer 4: Provider default + BASE_VARS`,
                    vars: BASE_VARS,
                    model: undefined  // Use provider default
                },
                {
                    name: `Layer 5: ${modelVariants[2] || modelVariants[0]} (alt variant) + Minimal`,
                    vars: 'temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,pressure_msl,precipitation',
                    model: modelVariants[2] || modelVariants[0]
                }
            ];
            let success = false;

            for (const layer of layers) {
                if (success) break;

                const buildUrl = (vars: string, modelOverride?: string) => {
                    const model = modelOverride || config.apiModel;
                    const baseParams = `latitude=${LOCATION.lat}&longitude=${LOCATION.lon}&hourly=${vars}&timezone=UTC&forecast_days=${config.days}&past_days=2&wind_speed_unit=kmh&precipitation_unit=mm`;

                    // Use ensemble API for ensemble models
                    if (config.provider === 'ensemble') {
                        let u = `https://ensemble-api.open-meteo.com/v1/ensemble?${baseParams}`;
                        if (model) u += `&models=${model}`;
                        return u;
                    }

                    // Standard forecast API for other models
                    let u = `https://api.open-meteo.com/v1/${config.provider}?${baseParams}`;
                    if (model) u += `&models=${model}`;
                    return u;
                };

                try {
                    const url = buildUrl(layer.vars, layer.model);
                    const timeout = (layer as any).timeout || 1000;

                    log(`[FETCH] ${config.id}: Trying ${layer.name}... (model=${layer.model || 'default'}, vars=${layer.vars.split(',').length} vars)`);

                    const response = await fetchWithRetry(url, 1, timeout);

                    if (!response.ok) {
                        log(`[FETCH] ${config.id}: ${layer.name} Failed (HTTP ${response.status})`);
                        continue;
                    }

                    const data = await response.json();

                    if (data && data.hourly && Array.isArray(data.hourly.time)) {
                        // VALIDATION: Check if we actually have data (non-null temperatures)
                        const rawTemps = data.hourly['temperature_2m'] || [];
                        const validCount = rawTemps.filter((v: any) => v !== null).length;

                        // Also check suffixed vars if main is empty
                        let hasData = validCount > 0;
                        if (!hasData) {
                            const keys = Object.keys(data.hourly).filter(k => k.startsWith('temperature_2m_'));
                            for (const k of keys) {
                                if ((data.hourly[k] || []).some((v: any) => v !== null)) {
                                    hasData = true;
                                    break;
                                }
                            }
                        }

                        if (!hasData) {
                            log(`[FETCH] ${config.id}: ${layer.name} returned empty data (all nulls). Skipping...`);
                            continue;
                        }

                        log(`[FETCH] ${config.id}: SUCCESS via ${layer.name}. (${data.hourly.time.length} hrs)`);
                        if (data.hourly.time.length <= 24) {
                            log(`[FETCH] ${config.id}: Data too short, trying next layer...`);
                            continue;
                        }
                        await storeForecast(config.id, layer.model, data, commonIssueTime);
                        success = true;
                    } else {
                        log(`[FETCH] ${config.id}: ${layer.name} returned invalid structure.`);
                    }
                } catch (error) {
                    // log(`[FETCH] ${config.id}: ${layer.name} Error: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            if (!success) {
                log(`[FETCH] ${config.id}: ALL 5 LAYERS FAILED. Model Unavailable.`);
                await db.setMetadata(`model_unavailable_${config.id}`, 'All layers failed');
            }
        });

        await Promise.allSettled(batchPromises);
        if (i + BATCH_SIZE < MODELS.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    await generateSyntheticModels(commonIssueTime);
    await db.setMetadata('last_forecast_fetch', commonIssueTime);
    log(`[FETCH] Complete.`);
}

export async function runVerification(): Promise<void> {
    log('[VERIFY] Starting verification process...');
    const observations: Observation[] = await db.getAll('observations');
    const allForecasts: Forecast[] = await db.getAll('forecasts');
    const forecastsByTime: Record<number, Forecast[]> = allForecasts.reduce((acc, f) => {
        acc[f.valid_time] = acc[f.valid_time] || [];
        acc[f.valid_time].push(f);
        return acc;
    }, {} as Record<number, Forecast[]>);

    const verifications: Verification[] = [];

    for (const obs of observations) {
        const matchingForecasts = forecastsByTime[obs.obs_time] || [];

        for (const forecast of matchingForecasts) {
            const leadTime = (forecast.valid_time - forecast.issue_time) / (3600 * 1000);

            if (leadTime < 0) continue;

            for (const { name, obsKey } of VERIFICATION_VARIABLES) {

                let obsVal: number | null = null;
                let fcstVal: number | null = forecast[name as keyof Forecast] as number | null;

                if (name === 'wind_vector') {
                    const fSpd = forecast.wind_speed_10m;
                    const fDir = forecast.wind_direction_10m;
                    const oSpd = obs.wind_speed ?? null;
                    const oDir = obs.wind_dir ?? null;

                    if (fSpd === null || oSpd === null || fDir === null || oDir === null) continue;

                    const toRad = Math.PI / 180;
                    const fU = -fSpd * Math.sin(fDir * toRad);
                    const fV = -fSpd * Math.cos(fDir * toRad);
                    const oU = -oSpd * Math.sin(oDir * toRad);
                    const oV = -oSpd * Math.cos(oDir * toRad);

                    const vectorError = Math.sqrt(Math.pow(fU - oU, 2) + Math.pow(fV - oV, 2));

                    verifications.push({
                        key: `${forecast.model_id}_wind_vector_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                        model_id: forecast.model_id, variable: 'wind_vector', valid_time: forecast.valid_time,
                        issue_time: forecast.issue_time, lead_time_hours: leadTime,
                        forecast_value: fSpd, observed_value: oSpd,
                        error: vectorError, absolute_error: vectorError, squared_error: vectorError * vectorError,
                        percentage_error: null, bias: vectorError
                    });
                    continue;
                }

                if (name === 'precipitation_probability') {
                    if (fcstVal === null) continue;
                    const p = fcstVal / 100;
                    // STRICT: Use ONLY METAR weather codes for occurrence. Ignore ERA5 amounts for probability/occurrence.
                    const obsHasPrecip = (obs.weather_codes && obs.weather_codes.length > 0);
                    const o = obsHasPrecip ? 1 : 0;
                    const brier = Math.pow(p - o, 2);
                    verifications.push({
                        key: `${forecast.model_id}_precip_prob_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                        model_id: forecast.model_id, variable: 'precipitation_probability', valid_time: forecast.valid_time,
                        issue_time: forecast.issue_time, lead_time_hours: leadTime,
                        forecast_value: fcstVal, observed_value: o * 100,
                        error: brier, absolute_error: brier, squared_error: brier,
                        percentage_error: null, bias: p - o
                    });
                    continue;
                }

                if (name.includes('occurrence')) {
                    let p = 0;
                    let o = 0;
                    const code = forecast.weather_code || 0;

                    if (name === 'rain_occurrence') {
                        if (forecast.weather_code === null && forecast.rain === null) continue;
                        const fHas = (forecast.rain && forecast.rain > 0.1) || (code >= 50 && code <= 69) || (code >= 80 && code <= 99);
                        p = fHas ? 1 : 0;
                        // STRICT: METAR Only
                        o = (obs.weather_codes && obs.weather_codes.includes('RA')) ? 1 : 0;
                    } else if (name === 'snow_occurrence') {
                        if (forecast.weather_code === null && forecast.snowfall === null) continue;
                        const fHas = (forecast.snowfall && forecast.snowfall > 0.1) || (code >= 70 && code <= 79) || (code >= 85 && code <= 86);
                        p = fHas ? 1 : 0;
                        // STRICT: METAR Only
                        o = (obs.weather_codes && obs.weather_codes.includes('SN')) ? 1 : 0;
                    } else if (name === 'freezing_rain_occurrence') {
                        if (forecast.weather_code === null) continue;
                        const fHas = [56, 57, 66, 67].includes(code);
                        p = fHas ? 1 : 0;
                        // STRICT: METAR Only
                        o = (obs.weather_codes && obs.weather_codes.includes('FZRA')) ? 1 : 0;
                    }

                    verifications.push({
                        key: `${forecast.model_id}_${name}_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                        model_id: forecast.model_id, variable: name, valid_time: forecast.valid_time,
                        issue_time: forecast.issue_time, lead_time_hours: leadTime,
                        forecast_value: p, observed_value: o,
                        error: Math.abs(p - o), absolute_error: Math.abs(p - o), squared_error: Math.pow(p - o, 2),
                        percentage_error: null, bias: p - o
                    });
                    continue;
                }

                // Standard Variables (Temp, Wind, etc)
                // For Precip Amounts, we use ERA5 because METAR doesn't have it.
                if (name === 'precipitation') obsVal = obs.era_precip_amt;
                else if (name === 'rain') obsVal = obs.era_rain_amt;
                else if (name === 'snowfall') obsVal = obs.era_snow_amt;
                else if (name === 'wind_gusts_10m') obsVal = obs.wind_gust ?? obs.era_wind_gust; // Prefer METAR gust, fallback to ERA5
                else obsVal = obs[obsKey as keyof Observation] as number | null;

                // Strict checks against NaN / Null
                if (obsVal === null || obsVal === undefined || !Number.isFinite(obsVal)) continue;
                if (fcstVal === null || fcstVal === undefined || !Number.isFinite(fcstVal)) continue;

                let error: number;
                if (name === 'wind_direction_10m') {
                    let diff = fcstVal - obsVal;
                    while (diff <= -180) diff += 360;
                    while (diff > 180) diff -= 360;
                    error = diff;
                } else {
                    error = fcstVal - obsVal;
                }

                verifications.push({
                    key: `${forecast.model_id}_${name}_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                    model_id: forecast.model_id, variable: name, valid_time: forecast.valid_time,
                    issue_time: forecast.issue_time, lead_time_hours: leadTime,
                    forecast_value: fcstVal, observed_value: obsVal, error: error,
                    absolute_error: Math.abs(error), squared_error: error * error,
                    percentage_error: obsVal !== 0 ? Math.abs(error / obsVal) * 100 : null,
                    bias: error
                });
            }
        }
    }
    await db.bulkPut('verification', verifications);
    log(`[VERIFY] Created/updated ${verifications.length} verification records.`);
}

// ... existing exports ...
export async function calculateModelVariableStats(bucketName: BucketName): Promise<ModelVariableStats[] | null> {
    const [minHours, maxHours] = LEAD_TIME_BUCKETS[bucketName];
    const records: Verification[] = await db.getAll('verification', 'by_lead_time', IDBKeyRange.bound(minHours, maxHours, false, true));

    if (records.length === 0) return null;

    const stats: Record<string, any> = {};

    for (const rec of records) {
        if (!Number.isFinite(rec.absolute_error)) continue;
        if (rec.variable !== 'pressure_msl' && rec.variable !== 'visibility' && !rec.variable.includes('occurrence') && !rec.variable.includes('probability') && rec.absolute_error > 2000) continue;

        const key = `${rec.model_id}::${rec.variable}`;
        if (!stats[key]) {
            stats[key] = {
                model_id: rec.model_id, variable: rec.variable,
                sum_ae: 0, sum_se: 0, sum_bias: 0,
                count: 0, values_ae: []
            };
        }
        stats[key].sum_ae += rec.absolute_error;
        stats[key].sum_se += rec.squared_error;
        stats[key].sum_bias += rec.bias;
        stats[key].values_ae.push(rec.absolute_error);
        stats[key].count++;
    }

    return Object.values(stats).map(s => {
        const n = s.count;
        if (n === 0) return null;

        const mae = s.sum_ae / n;
        const mse = s.sum_se / n;

        const sumSqDiff = s.values_ae.reduce((acc: number, val: number) => acc + Math.pow(val - mae, 2), 0);
        const stdDev = Math.sqrt(Math.max(0, sumSqDiff / n));
        const stdError = stdDev / Math.sqrt(n);

        return {
            model_id: s.model_id, variable: s.variable, n: n,
            mae: mae, mse: mse, rmse: Math.sqrt(Math.max(0, mse)), bias: s.sum_bias / n,
            mape: null, correlation: null, index_of_agreement: null, skill_score: null,
            std_error: Number.isFinite(stdError) ? stdError : null
        };
    }).filter((s): s is ModelVariableStats => s !== null);
}

export async function calculateCompositeStats(bucketName: BucketName): Promise<ModelVariableStats[] | null> {
    const allStats = await calculateModelVariableStats(bucketName);
    if (!allStats || allStats.length === 0) return null;

    const allowedVars = new Set<string>(VERIFICATION_VARIABLES.map(v => v.name));
    const validStats = allStats.filter(s => allowedVars.has(s.variable) && s.variable !== 'pressure_msl');

    if (validStats.length === 0) return null;

    const presentVariables = Array.from(new Set(validStats.map(s => s.variable)));
    const presentModels = Array.from(new Set(validStats.map(s => s.model_id)));

    const consensusMae: Record<string, number> = {};
    presentVariables.forEach(variable => {
        const statsForVar = validStats.filter(s => s.variable === variable);
        if (statsForVar.length > 0) {
            const sum = statsForVar.reduce((acc, val) => acc + val.mae, 0);
            consensusMae[variable] = sum / statsForVar.length;
        }
    });

    const scores: ModelVariableStats[] = presentModels.map(modelId => {
        let sumScore = 0;
        let varCount = 0;
        let totalN = 0;

        presentVariables.forEach(variable => {
            const stat = validStats.find(s => s.model_id === modelId && s.variable === variable);
            const baseline = consensusMae[variable];

            if (baseline === undefined || !Number.isFinite(baseline)) return;

            const threshold = MIN_MAE_THRESHOLDS[variable] || MIN_MAE_THRESHOLDS['default'];
            const denom = Math.max(baseline, threshold);

            if (stat) {
                sumScore += (stat.mae / denom);
                totalN += stat.n;
                varCount++;
            }
            // NO PENALTIES applied for missing data
        });

        if (varCount === 0) {
            return {
                model_id: modelId, variable: 'overall_score', mae: NaN, n: 0,
                mse: 0, rmse: 0, bias: 0, mape: null, correlation: null, index_of_agreement: null, skill_score: null, std_error: null
            };
        }

        const finalScore = sumScore / varCount;
        const avgN = Math.floor(totalN / varCount);

        return {
            model_id: modelId,
            variable: 'overall_score',
            mae: Number.isFinite(finalScore) ? finalScore : NaN,
            n: avgN,
            mse: 0, rmse: 0, bias: 0, mape: null, correlation: null, index_of_agreement: null, skill_score: null,
            std_error: null
        };
    }).filter(s => Number.isFinite(s.mae));

    return scores;
}

export async function getLeaderboardDataForBucket(bucketName: BucketName, variableFilter: string): Promise<LeaderboardRow[] | null> {
    let data: ModelVariableStats[] | null;
    if (variableFilter === 'overall_score') {
        data = await calculateCompositeStats(bucketName);
    } else {
        data = await calculateModelVariableStats(bucketName);
    }
    if (!data) return null;

    const filteredData = data.filter(d => (d.variable as string) === variableFilter && d.n > 0);

    return filteredData.map(stats => ({
        model: stats.model_id,
        avg_mae: stats.mae,
        avg_rmse: stats.rmse,
        avg_mse: stats.mse,
        avg_bias: stats.bias,
        avg_corr: stats.correlation,
        avg_skill: stats.skill_score,
        std_error: stats.std_error,
        total_verifications: stats.n
    })).sort((a, b) => a.avg_mae - b.avg_mae);
}

export async function getLatestIssueTime(): Promise<number | null> {
    const dbConn = await db.openDB();
    return new Promise((resolve, reject) => {
        const tx = dbConn.transaction('forecasts', 'readonly');
        const store = tx.objectStore('forecasts');

        if (!store.indexNames.contains('by_issue_time')) {
            resolve(null);
            return;
        }

        const index = store.index('by_issue_time');
        const req = index.openCursor(null, 'prev');
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                resolve(cursor.value.issue_time);
            } else {
                resolve(null);
            }
        };
        req.onerror = () => resolve(null);
    });
}

export async function getLatestObservation(): Promise<Observation | null> {
    const allObs = await db.getAll<Observation>('observations');
    if (allObs.length === 0) return null;

    // Sort by time descending
    const sorted = allObs.sort((a, b) => b.obs_time - a.obs_time);

    // Find the first observation that actually has data (temperature not null)
    // This avoids showing the very latest "placeholder" hour if the ERA5/METAR hasn't populated it yet
    const valid = sorted.find(o => o.temperature !== null);

    return valid || sorted[0];
}

export async function cleanupOldData(): Promise<void> {
    const cutoff = Date.now() - (14 * 24 * 3600 * 1000);
    const count = await db.cleanupOldDataDB(cutoff);
    log(`[CLEANUP] Removed ${count} old records`);
}

export async function exportVerificationDataCSV(): Promise<string> {
    const records: Verification[] = await db.getAll('verification');
    if (records.length === 0) return '';

    const header = [
        'Model', 'Variable', 'Issue Time (ISO)', 'Valid Time (ISO)', 'Lead Time (Hours)',
        'Forecast Value', 'Observed Value', 'Error', 'Abs Error'
    ].join(',');

    const rows = records.map(r => {
        return [
            r.model_id,
            r.variable,
            new Date(r.issue_time).toISOString(),
            new Date(r.valid_time).toISOString(),
            r.lead_time_hours.toFixed(1),
            r.forecast_value,
            r.observed_value,
            r.error.toFixed(4),
            r.absolute_error.toFixed(4)
        ].join(',');
    });

    return [header, ...rows].join('\n');
}

// --- DEEP ANALYSIS TEST SUITE ---
export async function testVerificationLogic() {
    log('--- STARTING DEEP VERIFICATION ANALYSIS ---');

    // Mock Observation: Clear METAR, but ERA5 shows Rain
    const obsClearEraRain: any = {
        obs_time: 1000, report_type: 'METAR', temperature: 20, dewpoint: 10, wind_dir: 180, wind_speed: 10, wind_gust: null, visibility: 10000, pressure_msl: 1013,
        raw_text: 'METAR CLR', ceiling_agl: null, precip_1h: 0,
        weather_codes: [], // EMPTY (Clear)
        era_precip_amt: 2.5, era_rain_amt: 2.5, era_snow_amt: 0, era_wind_gust: 20
    };

    // Mock Observation: Rain METAR, ERA5 0
    const obsRainEraDry: any = {
        obs_time: 2000, report_type: 'METAR', temperature: 20, dewpoint: 10, wind_dir: 180, wind_speed: 10, wind_gust: null, visibility: 5000, pressure_msl: 1013,
        raw_text: 'METAR RA', ceiling_agl: null, precip_1h: null,
        weather_codes: ['RA'], // RAIN
        era_precip_amt: 0, era_rain_amt: 0, era_snow_amt: 0, era_wind_gust: 20
    };

    // Mock Forecast: Predicts Rain (100%)
    const fcstRain: any = {
        id: 'test_rain', model_id: 'test_model', issue_time: 0, valid_time: 1000,
        temperature_2m: 20, dewpoint_2m: 10, wind_speed_10m: 10, wind_direction_10m: 180, wind_gusts_10m: 20,
        precip_probability: 100, rain: 5, snowfall: 0, weather_code: 61,
        surface_pressure: 1013, cloud_cover: 100, visibility: 5000
    };

    // Helper to simulate verification logic for a single pair
    const verify = (obs: any, fcst: any, varName: string) => {
        let o = 0;
        let f = 0;

        if (varName === 'precip_probability') {
            const obsHasPrecip = (obs.weather_codes && obs.weather_codes.length > 0);
            o = obsHasPrecip ? 1 : 0;
            f = fcst.precip_probability / 100;
        } else if (varName === 'rain_occurrence') {
            o = (obs.weather_codes && obs.weather_codes.includes('RA')) ? 1 : 0;
            f = 1; // Assuming forecast has rain
        } else if (varName === 'precip_1h') {
            o = obs.era_precip_amt || 0;
            f = fcst.rain; // Simplified
        } else if (varName === 'visibility') {
            o = obs.visibility;
            f = fcst.visibility;
        }
        return { o, f };
    };

    // TEST 1: METAR Clear, ERA5 Rain. Forecast Rain.
    // Expectation: Precip Prob Observed = 0 (Miss). Rain Occ Observed = 0 (Miss). Precip Amt Observed = 2.5 (ERA5).
    const t1_prob = verify(obsClearEraRain, fcstRain, 'precip_probability');
    const t1_occ = verify(obsClearEraRain, fcstRain, 'rain_occurrence');
    const t1_amt = verify(obsClearEraRain, fcstRain, 'precip_1h');

    log(`[TEST 1] (METAR=CLR, ERA5=Rain): Prob_Obs=${t1_prob.o} (Exp: 0), Occ_Obs=${t1_occ.o} (Exp: 0), Amt_Obs=${t1_amt.o} (Exp: 2.5)`);
    if (t1_prob.o !== 0 || t1_occ.o !== 0 || t1_amt.o !== 2.5) log('[TEST 1] FAILED');
    else log('[TEST 1] PASSED');

    // TEST 2: METAR Rain, ERA5 Dry. Forecast Rain.
    // Expectation: Prob Obs = 1 (Hit). Occ Obs = 1 (Hit). Amt Obs = 0 (ERA5).
    const t2_prob = verify(obsRainEraDry, fcstRain, 'precip_probability');
    const t2_occ = verify(obsRainEraDry, fcstRain, 'rain_occurrence');
    const t2_amt = verify(obsRainEraDry, fcstRain, 'precip_1h');

    log(`[TEST 2] (METAR=RA, ERA5=Dry): Prob_Obs=${t2_prob.o} (Exp: 1), Occ_Obs=${t2_occ.o} (Exp: 1), Amt_Obs=${t2_amt.o} (Exp: 0)`);
    if (t2_prob.o !== 1 || t2_occ.o !== 1 || t2_amt.o !== 0) log('[TEST 2] FAILED');
    else log('[TEST 2] PASSED');

    // TEST 3: Visibility
    // Forecast: 5000m. Obs: 10000m. Error: -5000.
    const t3_vis = verify(obsClearEraRain, fcstRain, 'visibility');
    log(`[TEST 3] (Visibility): Fcst=${t3_vis.f}, Obs=${t3_vis.o}. Error=${t3_vis.f - t3_vis.o} (Exp: -5000)`);
    if (t3_vis.f !== 5000 || t3_vis.o !== 10000) log('[TEST 3] FAILED');
    else log('[TEST 3] PASSED');

    // TEST 4: Mixed Precip (RASN)
    // Obs: "METAR RASN". Expect: Rain=1, Snow=1.
    const obsMixed: any = { ...obsClearEraRain, weather_codes: ['RA', 'SN'], raw_text: 'METAR RASN' };
    const t4_rain = verify(obsMixed, fcstRain, 'rain_occurrence');
    const t4_snow = verify(obsMixed, fcstRain, 'snow_occurrence'); // Need to update helper for snow

    // Update helper for snow first (in memory simulation for this test block)
    const verifySnow = (obs: any) => (obs.weather_codes && obs.weather_codes.includes('SN')) ? 1 : 0;

    log(`[TEST 4] (METAR=RASN): Rain_Obs=${t4_rain.o} (Exp: 1), Snow_Obs=${verifySnow(obsMixed)} (Exp: 1)`);
    if (t4_rain.o !== 1 || verifySnow(obsMixed) !== 1) log('[TEST 4] FAILED');
    else log('[TEST 4] PASSED');

    // TEST 5: False Alarm (Freezing Rain)
    // Forecast: FZRA (Code 66). Obs: Clear. Expect: Error=1 (Penalty).
    const fcstFzra: any = { ...fcstRain, weather_code: 66, rain: 0, snowfall: 0 }; // Code 66 = FZRA
    const obsClear: any = { ...obsClearEraRain, weather_codes: [] };

    // Helper update for FZRA
    const verifyFzra = (obs: any, fcst: any) => {
        const fHas = [56, 57, 66, 67].includes(fcst.weather_code);
        const p = fHas ? 1 : 0;
        const o = (obs.weather_codes && obs.weather_codes.includes('FZRA')) ? 1 : 0;
        return { p, o, error: Math.abs(p - o) };
    };

    const t5 = verifyFzra(obsClear, fcstFzra);
    log(`[TEST 5] (False Alarm FZRA): Fcst=${t5.p}, Obs=${t5.o}. Error=${t5.error} (Exp: 1)`);
    if (t5.error !== 1) log('[TEST 5] FAILED');
    else log('[TEST 5] PASSED');

    log('--- END ANALYSIS ---');
}

