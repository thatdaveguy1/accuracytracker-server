
import { MODELS, HOURLY_VARS, BASE_VARS, FULL_VARS, LIMITED_VARS, parseUTC, FORECAST_VARIABLES, VERIFICATION_VARIABLES, LEAD_TIME_BUCKETS, LOCATION, MIN_MAE_THRESHOLDS, MISSING_DATA_PENALTY_SCORE, isVariableSupported, CHECKWX_API_KEY } from '../constants';
import type { Forecast, Observation, Verification, BucketName, ModelVariableStats, LeaderboardRow } from '../types';
import db from '../db';

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
    db.prepare('DELETE FROM observations').run();

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
                // Server-side doesn't need CORS proxy usually, but keeping logic if direct fails
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
        const insert = db.prepare(`
            INSERT OR REPLACE INTO observations (obs_time, report_type, data)
            VALUES (@obs_time, @report_type, @data)
        `);
        const transaction = db.transaction((obsList: Observation[]) => {
            for (const obs of obsList) {
                insert.run({
                    obs_time: obs.obs_time,
                    report_type: obs.report_type,
                    data: JSON.stringify(obs)
                });
            }
        });
        transaction(observations);
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

        if (val !== undefined && val !== null) return Number.isFinite(val) ? val : null;

        // 2. Try with apiModel suffix (e.g. temperature_2m_ecmwf_aifs025)
        if (apiModel) {
            val = data.hourly[`${baseName}_${apiModel}`]?.[index];
            if (val !== undefined && val !== null) return Number.isFinite(val) ? val : null;
        }

        // 3. Try finding ANY key that starts with baseName (Desperate fallback for suffixed vars)
        const matchingKey = Object.keys(data.hourly).find(k => k.startsWith(baseName + '_'));
        if (matchingKey) {
            val = data.hourly[matchingKey]?.[index];
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
        if (validTime < issueTime) {
            continue;
        }

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

    if (forecasts.length > 0) {
        const insert = db.prepare(`
            INSERT OR REPLACE INTO forecasts (id, model_id, issue_time, valid_time, data)
            VALUES (@id, @model_id, @issue_time, @valid_time, @data)
        `);
        const transaction = db.transaction((list: Forecast[]) => {
            for (const f of list) {
                insert.run({
                    id: f.id,
                    model_id: f.model_id,
                    issue_time: f.issue_time,
                    valid_time: f.valid_time,
                    data: JSON.stringify(f)
                });
            }
        });
        transaction(forecasts);
        log(`[STORE] ${modelId}: Stored ${forecasts.length} forecast hours`);
    } else {
        log(`[STORE] ${modelId}: Warning - 0 hours stored. (Missing Temp?)`);
    }
}

async function generateSyntheticModels(issueTime: number): Promise<void> {
    log(`[SYNTHETIC] Generating Average/Median for issue time ${new Date(issueTime).toISOString()}...`);

    // Look back 10 days and forward 10 days
    const startValid = issueTime - (10 * 24 * 3600 * 1000);
    const endValid = issueTime + (10 * 24 * 3600 * 1000);
    const CHUNK_SIZE = 2 * 3600 * 1000; // Reduce to 2 hours to save memory

    let totalGenerated = 0;

    for (let currentStart = startValid; currentStart < endValid; currentStart += CHUNK_SIZE) {
        // Yield to event loop to prevent blocking and allow GC
        await new Promise(resolve => setImmediate(resolve));

        const currentEnd = currentStart + CHUNK_SIZE;

        // Scope the data processing to ensure variables can be GC'd immediately after the block
        {
            const rows = db.prepare(`
                SELECT data FROM forecasts 
                WHERE valid_time >= ? AND valid_time < ?
            `).all(currentStart, currentEnd) as { data: string }[];

            if (rows.length > 0) {
                const relevantForecasts: Forecast[] = rows.map(r => JSON.parse(r.data));

                // Group by BOTH valid_time AND issue_time
                const groups: Record<string, Forecast[]> = {};

                relevantForecasts.forEach(f => {
                    if (f.model_id.includes('_of_models')) return;
                    const key = `${f.valid_time}_${f.issue_time}`;
                    if (!groups[key]) groups[key] = [];
                    groups[key].push(f);
                });

                const syntheticForecasts: Forecast[] = [];
                for (const forecasts of Object.values(groups)) {
                    if (forecasts.length < 2) continue;

                    const vt = forecasts[0].valid_time;
                    const it = forecasts[0].issue_time;

                    const avgRecord: Partial<Forecast> = {
                        id: `average_of_models_${it}_${vt}`,
                        model_id: 'average_of_models',
                        issue_time: it,
                        valid_time: vt
                    };
                    const medRecord: Partial<Forecast> = {
                        id: `median_of_models_${it}_${vt}`,
                        model_id: 'median_of_models',
                        issue_time: it,
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

                if (syntheticForecasts.length > 0) {
                    const insert = db.prepare(`
                        INSERT OR REPLACE INTO forecasts (id, model_id, issue_time, valid_time, data)
                        VALUES (@id, @model_id, @issue_time, @valid_time, @data)
                    `);
                    const transaction = db.transaction((list: Forecast[]) => {
                        for (const f of list) {
                            insert.run({
                                id: f.id,
                                model_id: f.model_id,
                                issue_time: f.issue_time,
                                valid_time: f.valid_time,
                                data: JSON.stringify(f)
                            });
                        }
                    });
                    transaction(syntheticForecasts);
                    totalGenerated += syntheticForecasts.length;
                }
            }
        } // End of scope block

        // Force GC if available
        if (global.gc) {
            global.gc();
        }
    }

    log(`[SYNTHETIC] Generated ${totalGenerated / 2} hours for Average and Median models (Chunked Processing)`);
}

export async function fetchAllModels() {
    const commonIssueTime = Math.floor(Date.now() / 3600000) * 3600000;

    log(`[FETCH] Starting model fetch. Anchor Time: ${new Date(commonIssueTime).toISOString()}`);
    const BATCH_SIZE = 4;

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

                    log(`[FETCH] ${config.id}: Trying ${layer.name}... (model=${layer.model || 'default'}, vars=${layer.vars ? layer.vars.split(',').length : 0} vars)`);

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
                db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(`model_unavailable_${config.id}`, 'All layers failed');
            }
        });

        await Promise.allSettled(batchPromises);
        if (i + BATCH_SIZE < MODELS.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    await generateSyntheticModels(commonIssueTime);
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('last_forecast_fetch', commonIssueTime.toString());
    log(`[FETCH] Complete.`);
}

export async function runVerification(): Promise<void> {
    log('[VERIFY] Starting verification process...');

    // 1. Determine Time Range
    const range = db.prepare('SELECT MIN(valid_time) as minTime, MAX(valid_time) as maxTime FROM forecasts').get() as { minTime: number, maxTime: number };

    if (!range.minTime || !range.maxTime) {
        log('[VERIFY] No forecasts found to verify.');
        return;
    }

    const CHUNK_SIZE = 6 * 3600 * 1000; // 6 Hours
    let totalVerified = 0;

    // 2. Iterate in Chunks
    for (let currentStart = range.minTime; currentStart <= range.maxTime; currentStart += CHUNK_SIZE) {
        const currentEnd = currentStart + CHUNK_SIZE;

        // Scope block for GC
        {
            // Load Observations for this window (plus buffer for matching)
            const obsRows = db.prepare(`
                SELECT data FROM observations 
                WHERE obs_time >= ? AND obs_time < ?
            `).all(currentStart - 3600000, currentEnd + 3600000) as { data: string }[];

            const observations: Observation[] = obsRows.map(r => JSON.parse(r.data));
            const obsMap = new Map<number, Observation>();
            observations.forEach(o => obsMap.set(o.obs_time, o));

            // Load Forecasts for this window
            const fcstRows = db.prepare(`
                SELECT data FROM forecasts 
                WHERE valid_time >= ? AND valid_time < ?
            `).all(currentStart, currentEnd) as { data: string }[];

            if (fcstRows.length === 0) continue;

            const forecasts: Forecast[] = fcstRows.map(r => JSON.parse(r.data));
            const verifications: Verification[] = [];

            for (const forecast of forecasts) {
                const obs = obsMap.get(forecast.valid_time);
                if (!obs) continue;

                const leadTime = (forecast.valid_time - forecast.issue_time) / 3600000;
                if (leadTime < 0) continue;

                for (const name of FORECAST_VARIABLES) {
                    const fcstVal = (forecast as any)[name];

                    // Find matching observation key
                    const mapping = VERIFICATION_VARIABLES.find(m => m.name === name);
                    if (!mapping) continue;

                    let obsKey = mapping.obsKey;
                    let obsVal: number | null = null;

                    // Special Handling for Wind Direction
                    if (name === 'wind_direction_10m') {
                        const oDir = obs.wind_dir;
                        if (fcstVal === null || oDir === null || oDir === undefined) continue;

                        let diff = Math.abs(fcstVal - oDir);
                        if (diff > 180) diff = 360 - diff;

                        verifications.push({
                            key: `${forecast.model_id}_${name}_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                            model_id: forecast.model_id, variable: name, valid_time: forecast.valid_time,
                            issue_time: forecast.issue_time, lead_time_hours: leadTime,
                            forecast_value: fcstVal, observed_value: oDir,
                            error: diff, absolute_error: diff, squared_error: diff * diff,
                            percentage_error: null, bias: 0 // Direction bias is tricky, using 0 placeholder
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

                    // Standard Continuous Variables
                    if (obsKey === 'era_rain_amt') obsVal = obs.era_rain_amt;
                    else if (obsKey === 'era_snow_amt') obsVal = obs.era_snow_amt;
                    else if (obsKey === 'precip_1h') obsVal = obs.era_precip_amt ?? obs.precip_1h;

                    if (obsVal === null) {
                        obsVal = (obs as any)[obsKey];
                    }

                    if (obsVal !== null && fcstVal !== null) {
                        const error = fcstVal - obsVal;
                        const absError = Math.abs(error);
                        const sqError = error * error;
                        const pctError = obsVal !== 0 ? (absError / Math.abs(obsVal)) * 100 : null;

                        verifications.push({
                            key: `${forecast.model_id}_${name}_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                            model_id: forecast.model_id, variable: name, valid_time: forecast.valid_time,
                            issue_time: forecast.issue_time, lead_time_hours: leadTime,
                            forecast_value: fcstVal, observed_value: obsVal,
                            error: error, absolute_error: absError, squared_error: sqError,
                            percentage_error: pctError, bias: error
                        });
                    }
                }
            }

            if (verifications.length > 0) {
                const insert = db.prepare(`
                    INSERT OR REPLACE INTO verifications (
                        key, model_id, variable, valid_time, issue_time, lead_time_hours,
                        forecast_value, observed_value, error, absolute_error, squared_error, bias
                    ) VALUES (
                        @key, @model_id, @variable, @valid_time, @issue_time, @lead_time_hours,
                        @forecast_value, @observed_value, @error, @absolute_error, @squared_error, @bias
                    )
                `);
                const transaction = db.transaction((list: Verification[]) => {
                    for (const v of list) {
                        insert.run(v);
                    }
                });
                transaction(verifications);
                totalVerified += verifications.length;
            }
        } // End Scope

        if (global.gc) global.gc();
    }

    log(`[VERIFY] Verification Complete. Total records: ${totalVerified}`);
}
