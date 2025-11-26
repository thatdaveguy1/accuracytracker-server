
import { MODELS, HOURLY_VARS, BASE_VARS, parseUTC, FORECAST_VARIABLES, VERIFICATION_VARIABLES, LEAD_TIME_BUCKETS, LOCATION, MIN_MAE_THRESHOLDS, MISSING_DATA_PENALTY_SCORE, isVariableSupported } from '../constants';
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
                pressure_msl: data.hourly.pressure_msl?.[i] ? data.hourly.pressure_msl[i] * 33.8639 : null, // hPa to inHg
                wind_speed: data.hourly.wind_speed_10m?.[i] ? data.hourly.wind_speed_10m[i] / 1.852 : null, // kmh to kts
                wind_dir: data.hourly.wind_direction_10m?.[i] ?? null,
                era_precip_amt: data.hourly.precipitation?.[i] ?? null,
                era_rain_amt: data.hourly.rain?.[i] ?? null,
                era_snow_amt: data.hourly.snowfall?.[i] ?? null,
                era_wind_gust: data.hourly.wind_gusts_10m?.[i] ? data.hourly.wind_gusts_10m[i] / 1.852 : null, // kmh to kts
            };
        });
        
        log(`[HYBRID] Retrieved ${Object.keys(hybridMap).length} hours of reanalysis data.`);
        return hybridMap;
        
    } catch (e) {
        log(`[HYBRID] Failed to fetch reanalysis data: ${e}`);
        return {};
    }
}

export async function fetchMETARHistory(): Promise<Observation[]> {
  log('[METAR] Fetching last 72 hours of observations...');
  
  const targetUrl = `https://aviationweather.gov/api/data/metar?ids=${LOCATION.name}&format=json&hours=72`;
  
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    `https://cors.eu.org/${targetUrl}`,
    targetUrl 
  ];
  
  let rawMetars: any[] = [];
  let fetchSuccess = false;
  
  for (let i = 0; i < proxies.length; i++) {
    const url = proxies[i];
    try {
      const response = await fetchWithRetry(url, 2, 500);
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        rawMetars = data;
        fetchSuccess = true;
        log(`[METAR] ✓ Success via ${new URL(url).hostname}`);
        break;
      }
    } catch (error) {
       // continue
    }
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

  const metarMap: Record<number, any> = {};
  rawMetars.forEach((metar: any) => {
      const rawTime = metar.obsTime ?? metar.obstime ?? metar.time ?? metar.created_at;
      let obsTimeEpoch: number = 0;
      if (typeof rawTime === 'number') obsTimeEpoch = rawTime < 100000000000 ? rawTime * 1000 : rawTime;
      else if (typeof rawTime === 'string') obsTimeEpoch = parseUTC(rawTime);
      
      if (obsTimeEpoch > 0) {
          const alignedHour = Math.round(obsTimeEpoch / 3600000) * 3600000;
          const existing = metarMap[alignedHour];
          if (!existing) {
              metarMap[alignedHour] = { ...metar, exactTime: obsTimeEpoch };
          } else {
              const diffCurrent = Math.abs(existing.exactTime - alignedHour);
              const diffNew = Math.abs(obsTimeEpoch - alignedHour);
              if (diffNew < diffCurrent) {
                   metarMap[alignedHour] = { ...metar, exactTime: obsTimeEpoch };
              }
          }
      }
  });

  for (let i = 0; i < 72; i++) {
      const targetTime = currentHour - (i * 3600000);
      const metar = metarMap[targetTime];
      const era = hybridData[targetTime];

      if (!metar && !era) continue;

      let obs: Observation;

      if (metar) {
          const rawText = metar.rawOb || '';
          let ceilingAgl: number | null = null;
          if (Array.isArray(metar.clouds)) {
              for (const layer of metar.clouds) {
                  if (['BKN', 'OVC', 'VV'].includes(layer.cover) && layer.base != null) {
                      ceilingAgl = layer.base * 0.3048; 
                      break; 
                  }
              }
          }
          let precipMm: number | null = null;
          if (metar.precipIn != null) precipMm = metar.precipIn * 25.4;
          else if (metar.precip !== null && metar.precip !== undefined) {
              precipMm = parseNum(metar.precip); 
              if (precipMm !== null) precipMm = precipMm * 25.4; 
          } else {
              if (rawText.includes('P0000')) precipMm = 0;
          }

          const weatherCodes: string[] = [];
          if (/\b(FZRA|FZDZ)\b/.test(rawText)) weatherCodes.push('FZRA');
          if (/\b(RA|DZ|SHRA|TSRA)\b/.test(rawText) && !weatherCodes.includes('FZRA')) weatherCodes.push('RA');
          if (/\b(SN|SG|SHSN|BLSN)\b/.test(rawText)) weatherCodes.push('SN');
          if (/\bTS/.test(rawText) || rawText.includes('TSRA')) weatherCodes.push('TS');

          obs = {
              obs_time: targetTime, 
              report_type: rawText.includes('SPECI') ? 'SPECI' : 'METAR',
              temperature: parseNum(metar.temp),
              dewpoint: parseNum(metar.dewp),
              wind_dir: parseNum(metar.wdir),
              wind_speed: parseNum(metar.wspd) !== null ? parseNum(metar.wspd)! * 1.852 : null, 
              wind_gust: (parseNum(metar.wgst) ?? parseNum(metar.gust) ?? null) !== null ? (parseNum(metar.wgst) ?? parseNum(metar.gust))! * 1.852 : null,
              visibility: parseNum(metar.visib) !== null ? parseNum(metar.visib)! * 1609.34 : null,
              pressure_msl: parseNum(metar.altim) !== null ? parseNum(metar.altim)! * 33.8639 : null,
              raw_text: rawText,
              precip_1h: precipMm,
              ceiling_agl: ceilingAgl,
              weather_codes: weatherCodes,
              era_precip_amt: era?.era_precip_amt ?? null,
              era_rain_amt: era?.era_rain_amt ?? null,
              era_snow_amt: era?.era_snow_amt ?? null,
              era_wind_gust: era?.era_wind_gust ?? null
          };
      } else {
          obs = {
              obs_time: targetTime,
              report_type: 'SYNTHETIC',
              temperature: era?.temperature ?? null,
              dewpoint: era?.dewpoint ?? null,
              wind_dir: era?.wind_dir ?? null,
              wind_speed: era?.wind_speed ?? null, 
              wind_gust: era?.era_wind_gust ?? null, 
              visibility: null,
              pressure_msl: era?.pressure_msl ?? null,
              raw_text: "METAR MISSING - ERA5 FILL",
              precip_1h: null,
              ceiling_agl: null,
              weather_codes: [],
              era_precip_amt: era?.era_precip_amt ?? null,
              era_rain_amt: era?.era_rain_amt ?? null,
              era_snow_amt: era?.era_snow_amt ?? null,
              era_wind_gust: era?.era_wind_gust ?? null
          };
      }
      observations.push(obs);
  }
  
  if (observations.length > 0) {
    await db.bulkPut('observations', observations);
    log(`[METAR] Stored ${observations.length} observations (Merged/Hybrid)`);
    return observations;
  }
  return [];
}

async function storeForecast(modelId: string, apiModel: string | undefined, data: any, issueTime: number): Promise<void> {
  const times = data.hourly.time;
  const forecasts: Forecast[] = [];
  
  const getVal = (baseName: string, index: number): number | null => {
      const std = data.hourly[baseName]?.[index];
      if (std !== undefined && std !== null) return Number.isFinite(std) ? std : null;
      if (apiModel) {
          const suffixed = data.hourly[`${baseName}_${apiModel}`]?.[index];
          if (suffixed !== undefined && suffixed !== null) return Number.isFinite(suffixed) ? suffixed : null;
      }
      return null;
  };

  const now = Date.now();

  for (let i = 0; i < times.length; i++) {
    const validTime = parseUTC(times[i]);
    let recordIssueTime = issueTime;

    // Tiered Backfill Logic
    if (validTime <= now) {
        const hoursAgo = (now - validTime) / 3600000;
        
        if (hoursAgo <= 24) {
             recordIssueTime = validTime - (12 * 3600 * 1000); 
        } else if (hoursAgo <= 48) {
             recordIssueTime = validTime - (36 * 3600 * 1000);
        } else {
             recordIssueTime = validTime - (60 * 3600 * 1000);
        }
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
  await db.bulkPut('forecasts', forecasts);
  if (forecasts.length > 0) {
      log(`[STORE] ${modelId}: Stored ${forecasts.length} forecast hours`);
  } else {
      log(`[STORE] ${modelId}: Warning - 0 hours stored. (Missing Temp?)`);
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

  for (let i = 0; i < MODELS.length; i += BATCH_SIZE) {
    const batch = MODELS.slice(i, i + BATCH_SIZE);
    log(`[FETCH] Processing batch ${Math.floor(i/BATCH_SIZE) + 1}...`);
    
    const batchPromises = batch.map(async (config) => {
      const varsToFetch = config.vars || HOURLY_VARS;
      
      const buildUrl = (vars: string, modelOverride?: string) => {
          // Increase past_days to 2 to support bucket backfill
          let u = `https://api.open-meteo.com/v1/${config.provider}?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}&hourly=${vars}&timezone=UTC&forecast_days=${config.days}&past_days=2&wind_speed_unit=kmh&precipitation_unit=mm`;
          const model = modelOverride || config.apiModel;
          if (model) u += `&models=${model}`;
          return u;
      };

      try {
        let response = await fetchWithRetry(buildUrl(varsToFetch), 3, 1000);
        
        // Auto-fallback
        if (response.status === 400) {
             log(`[FETCH] ${config.id}: HTTP 400. Retrying with LIMITED vars...`);
             response = await fetchWithRetry(buildUrl(LIMITED_VARS), 2, 1000);
        }

        if (!response.ok && config.id === 'ecmwf-aifs') {
             log(`[FETCH] ${config.id}: AIFS failed. Fallback to ECMWF IFS 0.4...`);
             response = await fetchWithRetry(buildUrl(varsToFetch, 'ecmwf_ifs04'), 2, 1000);
        }

        if (!response.ok) {
            log(`[FETCH] ${config.id}: HTTP ${response.status}`);
            return;
        }

        const data = await response.json();
        
        if (data && data.hourly && Array.isArray(data.hourly.time)) {
            log(`[FETCH] ${config.id}: Success, ${data.hourly.time.length} hours received`);
            if (data.hourly.time.length <= 24) return;
            await storeForecast(config.id, config.apiModel, data, commonIssueTime);
        } else {
             log(`[FETCH] ${config.id}: Invalid data structure.`);
        }
      } catch (error) {
          log(`[FETCH] ${config.id}: Failed - ${error instanceof Error ? error.message : String(error)}`);
          await db.setMetadata(`model_unavailable_${config.id}`, String(error));
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

        if (name === 'precip_probability') {
            if (fcstVal === null) continue;
            const p = fcstVal / 100; 
            const obsHasPrecip = (obs.weather_codes && obs.weather_codes.length > 0) || (obs.era_precip_amt !== null && obs.era_precip_amt > 0.1);
            const o = obsHasPrecip ? 1 : 0;
            const brier = Math.pow(p - o, 2);
            verifications.push({
                key: `${forecast.model_id}_precip_prob_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                model_id: forecast.model_id, variable: 'precip_probability', valid_time: forecast.valid_time,
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
                o = (obs.weather_codes && obs.weather_codes.includes('RA')) || (obs.era_rain_amt && obs.era_rain_amt > 0.1) ? 1 : 0;
            } else if (name === 'snow_occurrence') {
                if (forecast.weather_code === null && forecast.snowfall === null) continue;
                const fHas = (forecast.snowfall && forecast.snowfall > 0.1) || (code >= 70 && code <= 79) || (code >= 85 && code <= 86);
                p = fHas ? 1 : 0;
                o = (obs.weather_codes && obs.weather_codes.includes('SN')) || (obs.era_snow_amt && obs.era_snow_amt > 0.1) ? 1 : 0;
            } else if (name === 'freezing_rain_occurrence') {
                if (forecast.weather_code === null) continue;
                const fHas = [56, 57, 66, 67].includes(code);
                p = fHas ? 1 : 0;
                o = (obs.weather_codes && obs.weather_codes.includes('FZRA')) ? 1 : 0;
            }
            const err = Math.pow(p - o, 2);
            verifications.push({
                key: `${forecast.model_id}_${name}_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                model_id: forecast.model_id, variable: name, valid_time: forecast.valid_time,
                issue_time: forecast.issue_time, lead_time_hours: leadTime,
                forecast_value: p, observed_value: o,
                error: err, absolute_error: err, squared_error: err,
                percentage_error: null, bias: p - o
            });
            continue;
        }

        if (name === 'wind_gusts_10m') {
            if (obs.wind_gust !== null) obsVal = obs.wind_gust;
            else if (obs.era_wind_gust !== null) obsVal = obs.era_wind_gust;
            else continue;
        }
        else if (name === 'precipitation') {
            if (obs.precip_1h !== null && obs.precip_1h >= 0) obsVal = obs.precip_1h;
            else if (obs.era_precip_amt !== null) obsVal = obs.era_precip_amt;
            else continue;
        }
        else if (name === 'snow_amount') {
             obsVal = obs.era_snow_amt;
             fcstVal = forecast.snowfall;
        }
        else if (name === 'freezing_rain_amount') {
             if (obs.weather_codes.includes('FZRA')) obsVal = obs.era_rain_amt || 0;
             else obsVal = 0;
             if ([56, 57, 66, 67].includes(forecast.weather_code || 0)) fcstVal = forecast.rain || 0;
             else fcstVal = 0;
        }
        else {
             obsVal = obs[obsKey as keyof Observation] as number | null;
        }

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
        if (rec.variable !== 'pressure_msl' && !rec.variable.includes('occurrence') && !rec.variable.includes('probability') && rec.absolute_error > 2000) continue;
        
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
