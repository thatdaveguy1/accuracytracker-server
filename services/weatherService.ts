
import { MODELS, HOURLY_VARS, parseUTC, FORECAST_VARIABLES, VERIFICATION_VARIABLES, LEAD_TIME_BUCKETS, LOCATION, MIN_MAE_THRESHOLDS, MISSING_DATA_PENALTY_SCORE, type ModelConfig } from '../constants';
import type { Forecast, Observation, Verification, BucketName, ModelVariableStats, LeaderboardRow } from '../types';
import * as db from './db';

type LogFn = (message: string) => void;

let log: LogFn = (message: string) => console.log(message);
export const setLogger = (logger: LogFn) => {
    log = logger;
}

const fetchWithRetry = async (url: string, retries = 3, delay = 1000): Promise<Response> => {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            // Open-Meteo returns 400 for validation, 429 for throttle, 5xx for server
            if (res.status === 429 || res.status >= 500) {
                throw new Error(`HTTP ${res.status}`);
            }
            return res;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, delay * Math.pow(2, i))); // Exponential backoff
        }
    }
    throw new Error('Max retries reached');
};

export async function fetchMETARHistory(): Promise<Observation[]> {
  log('[METAR] Fetching last 24 hours of observations...');
  
  const targetUrl = `https://aviationweather.gov/api/data/metar?ids=${LOCATION.name}&format=json&hours=24`;
  
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    `https://cors.eu.org/${targetUrl}`,
    targetUrl 
  ];
  
  for (let i = 0; i < proxies.length; i++) {
    const url = proxies[i];
    const proxyName = new URL(url).hostname;
    
    try {
      log(`[METAR] Attempting via ${proxyName}...`);
      
      const response = await fetchWithRetry(url, 2, 500);
      
      if (!response.ok) {
        log(`[METAR] ${proxyName} returned ${response.status}, trying next...`);
        continue;
      }
      
      const data = await response.json();
      
      if (!Array.isArray(data) || data.length === 0) {
        log(`[METAR] ${proxyName} returned empty/invalid data, trying next...`);
        continue;
      }
      
      log(`[METAR] ✓ ${proxyName} succeeded! Processing ${data.length} items...`);
      
      const parseNum = (val: any): number | null => {
          const n = parseFloat(val);
          return isFinite(n) ? n : null;
      };

      const observations: Observation[] = data.map((metar: any) => {
        const rawTime = metar.obsTime ?? metar.obstime ?? metar.time ?? metar.created_at;
        let obsTimeEpoch: number;

        if (typeof rawTime === 'number') {
            obsTimeEpoch = rawTime; 
            if (obsTimeEpoch < 100000000000) obsTimeEpoch *= 1000; 
        } else if (typeof rawTime === 'string') {
            obsTimeEpoch = parseUTC(rawTime);
        } else {
            return null; 
        }

        if (obsTimeEpoch === 0) return null;
        
        const rawText = metar.rawOb || '';

        // 1. Cloud Ceiling
        let ceilingAgl: number | null = null;
        if (Array.isArray(metar.clouds)) {
            for (const layer of metar.clouds) {
                if (['BKN', 'OVC', 'VV'].includes(layer.cover) && layer.base != null) {
                    ceilingAgl = layer.base * 0.3048; 
                    break; 
                }
            }
        }

        // 2. Precipitation
        let precipMm: number | null = null;
        if (metar.precipIn != null) {
            precipMm = metar.precipIn * 25.4;
        } else if (metar.precip !== null && metar.precip !== undefined) {
             precipMm = parseNum(metar.precip); 
             if (precipMm !== null) precipMm = precipMm * 25.4; 
        } else {
             precipMm = null;
             if (rawText.includes('P0000')) {
                 precipMm = 0;
             }
        }

        // 3. Weather Code Parsing
        const weatherCodes: string[] = [];
        if (/\b(FZRA|FZDZ)\b/.test(rawText)) weatherCodes.push('FZRA');
        if (/\b(RA|DZ|SHRA|TSRA)\b/.test(rawText) && !weatherCodes.includes('FZRA')) weatherCodes.push('RA');
        if (/\b(SN|SG|SHSN|BLSN)\b/.test(rawText)) weatherCodes.push('SN');
        if (/\b(TS)\b/.test(rawText)) weatherCodes.push('TS');

        return {
            obs_time: obsTimeEpoch,
            report_type: (rawText).includes('SPECI') ? 'SPECI' : 'METAR',
            temperature: parseNum(metar.temp),
            dewpoint: parseNum(metar.dewp),
            wind_dir: parseNum(metar.wdir),
            wind_speed: parseNum(metar.wspd) !== null ? parseNum(metar.wspd)! * 1.852 : null,
            wind_gust: parseNum(metar.wgst) !== null ? parseNum(metar.wgst)! * 1.852 : null,
            visibility: parseNum(metar.visib) !== null ? parseNum(metar.visib)! * 1.60934 : null,
            pressure_msl: parseNum(metar.altim) !== null ? parseNum(metar.altim)! * 33.8639 : null,
            raw_text: rawText,
            precip_1h: precipMm,
            ceiling_agl: ceilingAgl,
            weather_codes: weatherCodes
        };
      }).filter((o): o is Observation => o !== null);
      
      if (observations.length > 0) {
        await db.bulkPut('observations', observations);
        log(`[METAR] Stored ${observations.length} valid observations`);
        return observations;
      }
      
    } catch (error) {
      log(`[METAR] ${proxyName} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  log('[METAR] All proxies failed. No observations retrieved.');
  return [];
}

async function storeForecast(modelId: string, apiModel: string | undefined, data: any, issueTime: number): Promise<void> {
  const times = data.hourly.time;
  const forecasts: Forecast[] = [];
  
  // Helper to safely extract variable, trying both standard name and suffixed name (e.g. temp_2m_gem_hrdps)
  const getVal = (baseName: string, index: number): number | null => {
      const std = data.hourly[baseName]?.[index];
      if (std !== undefined) return std;
      if (apiModel) {
          const suffixed = data.hourly[`${baseName}_${apiModel}`]?.[index];
          if (suffixed !== undefined) return suffixed;
      }
      return null;
  };

  for (let i = 0; i < times.length; i++) {
    const validTime = parseUTC(times[i]);
    
    const recordIssueTime = issueTime;

    let precip = getVal('precipitation', i);
    let rain = getVal('rain', i);
    let showers = getVal('showers', i);
    let snowfall = getVal('snowfall', i);

    if (precip === 0) {
        if (rain === null) rain = 0;
        if (showers === null) showers = 0;
        if (snowfall === null) snowfall = 0;
    }

    // Check if critical data exists for this hour
    const temp = getVal('temperature_2m', i);
    if (temp === null) continue; // Skip hours with no valid core data

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
        visibility: getVal('visibility', i) !== null ? getVal('visibility', i)! / 1000 : null,
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
  log(`[STORE] ${modelId}: Stored ${forecasts.length} forecast hours`);
}

async function generateSyntheticModels(issueTime: number): Promise<void> {
    log(`[SYNTHETIC] Generating Average/Median for issue time ${new Date(issueTime).toISOString()}...`);
    
    // Narrower window to prevent fetching irrelevant old data
    const startValid = issueTime - (24 * 3600 * 1000); 
    const endValid = issueTime + (10 * 24 * 3600 * 1000);
    
    const relevantForecasts: Forecast[] = await db.getAll('forecasts', 'by_valid_time', IDBKeyRange.bound(startValid, endValid));
    
    const validTimeGroups: Record<number, Forecast[]> = {};
    relevantForecasts.forEach(f => {
        // Fix: Ensure we don't accidentally include previous synthetic models in the calculation
        if (f.model_id.includes('_of_models')) return;
        
        // Fix: Strict Issue Time matching to avoid mixing batch runs
        if (Math.abs(f.issue_time - issueTime) > 60000) return; 

        if (!validTimeGroups[f.valid_time]) validTimeGroups[f.valid_time] = [];
        validTimeGroups[f.valid_time].push(f);
    });

    const syntheticForecasts: Forecast[] = [];
    for (const [validTimeStr, forecasts] of Object.entries(validTimeGroups)) {
        const vt = parseInt(validTimeStr, 10);
        
        // Minimum consensus count
        if (forecasts.length < 2) continue;

        const avgRecord: Partial<Forecast> = { 
            id: `average_of_models_${issueTime}_${vt}`, 
            model_id: 'average_of_models', 
            issue_time: issueTime, 
            valid_time: vt 
        };
        const medRecord: Partial<Forecast> = { 
            id: `median_of_models_${issueTime}_${vt}`, 
            model_id: 'median_of_models', 
            issue_time: issueTime, 
            valid_time: vt 
        };

        for (const varName of FORECAST_VARIABLES) {
            const values = forecasts.map(f => f[varName as keyof Forecast]).filter(v => v !== null && !isNaN(v as number)) as number[];
            
            if (values.length > 0) {
                if (varName === 'wind_direction_10m') {
                    let sumSin = 0;
                    let sumCos = 0;
                    values.forEach(deg => {
                        const rad = deg * (Math.PI / 180);
                        sumSin += Math.sin(rad);
                        sumCos += Math.cos(rad);
                    });
                    let avgDeg = Math.atan2(sumSin / values.length, sumCos / values.length) * (180 / Math.PI);
                    if (avgDeg < 0) avgDeg += 360;
                    (avgRecord as any)[varName] = avgDeg;
                    
                    const sorted = [...values].sort((a, b) => a - b);
                    (medRecord as any)[varName] = sorted[Math.floor(sorted.length / 2)];
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
  const startSystemTime = Date.now();
  log(`[FETCH] Starting model fetch. Anchor System time: ${new Date(startSystemTime).toISOString()}`);
  
  const commonIssueTime = startSystemTime;
  const BATCH_SIZE = 4;

  for (let i = 0; i < MODELS.length; i += BATCH_SIZE) {
    const batch = MODELS.slice(i, i + BATCH_SIZE);
    log(`[FETCH] Processing batch ${Math.floor(i/BATCH_SIZE) + 1}...`);
    
    const batchPromises = batch.map(async (config) => {
      let url = `https://api.open-meteo.com/v1/${config.provider}?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}&hourly=${HOURLY_VARS}&timezone=UTC&forecast_days=${config.days}&past_days=1`;
      
      if (config.apiModel) {
          url += `&models=${config.apiModel}`;
      }
      
      try {
        const response = await fetchWithRetry(url, 3, 1000); 
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
    
    await Promise.all(batchPromises);
    
    if (i + BATCH_SIZE < MODELS.length) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit spacing
    }
  }

  await generateSyntheticModels(commonIssueTime);
  await db.setMetadata('last_forecast_fetch', commonIssueTime);
  log(`[FETCH] Complete.`);
}

export async function runVerification(): Promise<void> {
  log('[VERIFY] Starting verification process...');
  
  const allObs: Observation[] = await db.getAll('observations');
  
  // Filter to keeping only the observation closest to top-of-hour per hour.
  const observations: Observation[] = [];
  const obsByHour: Record<string, Observation[]> = {};
  
  allObs.forEach(o => {
      const date = new Date(o.obs_time);
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}`;
      if (!obsByHour[key]) obsByHour[key] = [];
      obsByHour[key].push(o);
  });

  Object.values(obsByHour).forEach(hourlyGroup => {
      hourlyGroup.sort((a, b) => {
          const aMin = new Date(a.obs_time).getUTCMinutes();
          const bMin = new Date(b.obs_time).getUTCMinutes();
          const aDist = Math.min(aMin, 60 - aMin);
          const bDist = Math.min(bMin, 60 - bMin);
          return aDist - bDist;
      });
      observations.push(hourlyGroup[0]);
  });

  log(`[VERIFY] Filtered to ${observations.length} hourly representative observations (from ${allObs.length} total)`);

  if (observations.length < 2) {
    log(`[VERIFY] Need at least 2 hourly observations for meaningful verification.`);
  }

  const allForecasts: Forecast[] = await db.getAll('forecasts');
  const forecastsByTime: Record<number, Forecast[]> = allForecasts.reduce((acc, f) => {
    acc[f.valid_time] = acc[f.valid_time] || [];
    acc[f.valid_time].push(f);
    return acc;
  }, {} as Record<number, Forecast[]>);

  const verifications: Verification[] = [];
  const tolerance = 30 * 60 * 1000;

  for (const obs of observations) {
    const minTime = obs.obs_time - tolerance;
    const maxTime = obs.obs_time + tolerance; 
    const matchingForecasts: Forecast[] = [];

    for(const timeStr in forecastsByTime) {
        const time = parseInt(timeStr, 10);
        if(time >= minTime && time <= maxTime) {
            matchingForecasts.push(...forecastsByTime[time]);
        }
    }
    
    for (const forecast of matchingForecasts) {
      const leadTime = (forecast.valid_time - forecast.issue_time) / (3600 * 1000);
      
      // Allow negative lead times (hindcasts) down to -24h
      if (leadTime < -24) continue;

      for (const { name, obsKey } of VERIFICATION_VARIABLES) {
        
        // 1. Wind Vector
        if (name === 'wind_vector') {
            const fSpd = forecast.wind_speed_10m;
            const fDir = forecast.wind_direction_10m;
            const oSpd = obs.wind_speed;
            const oDir = obs.wind_dir;

            if (fSpd === null || oSpd === null) continue;
            
            const safeFDir = fDir ?? 0;
            const safeODir = oDir ?? 0;
            
            if (fSpd > 0 && fDir === null) continue;
            if (oSpd > 0 && oDir === null) continue;

            const toRad = Math.PI / 180;
            const fU = -fSpd * Math.sin(safeFDir * toRad);
            const fV = -fSpd * Math.cos(safeFDir * toRad);
            const oU = -oSpd * Math.sin(safeODir * toRad);
            const oV = -oSpd * Math.cos(safeODir * toRad);

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

        // 2. Precip Probability (Brier Score)
        if (name === 'precip_probability') {
            const fProb = forecast.precipitation_probability;
            if (fProb === null) continue;
            
            const p = fProb / 100;
            const obsHasPrecip = (obs.weather_codes && obs.weather_codes.length > 0) || (obs.precip_1h !== null && obs.precip_1h > 0.1);
            const o = obsHasPrecip ? 1 : 0;
            const brier = Math.pow(p - o, 2);

            verifications.push({
                key: `${forecast.model_id}_precip_prob_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                model_id: forecast.model_id, variable: 'precip_probability', valid_time: forecast.valid_time,
                issue_time: forecast.issue_time, lead_time_hours: leadTime,
                forecast_value: fProb, observed_value: o * 100,
                error: brier, absolute_error: brier, squared_error: brier,
                percentage_error: null, bias: p - o
            });
            continue;
        }

        // 3. Binary Occurrences
        if (name.includes('occurrence')) {
            let p = 0;
            let o = 0;
            const code = forecast.weather_code || 0;
            
            if (name === 'rain_occurrence') {
                if (forecast.weather_code === null && forecast.rain === null) continue;
                const fHas = (forecast.rain && forecast.rain > 0.1) || (code >= 50 && code <= 69) || (code >= 80 && code <= 99);
                p = fHas ? 1 : 0;
                o = (obs.weather_codes && obs.weather_codes.includes('RA')) ? 1 : 0;
            } else if (name === 'snow_occurrence') {
                if (forecast.weather_code === null && forecast.snowfall === null) continue;
                const fHas = (forecast.snowfall && forecast.snowfall > 0.1) || (code >= 70 && code <= 79) || (code >= 85 && code <= 86);
                p = fHas ? 1 : 0;
                o = (obs.weather_codes && obs.weather_codes.includes('SN')) ? 1 : 0;
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

        // 4. Specific Amounts
        if (name === 'rain_amount') {
             const isMixed = obs.weather_codes.includes('RA') && obs.weather_codes.includes('SN');
             if (isMixed) continue;
             
             if (forecast.rain === null) continue;

             const obsRain = obs.weather_codes.includes('RA') ? (obs.precip_1h || 0) : 0;
             const val = forecast.rain;
             const err = val - obsRain;
             
             verifications.push({
                key: `${forecast.model_id}_rain_amount_${forecast.valid_time}_${leadTime.toFixed(1)}`,
                model_id: forecast.model_id, variable: 'rain_amount', valid_time: forecast.valid_time,
                issue_time: forecast.issue_time, lead_time_hours: leadTime,
                forecast_value: val, observed_value: obsRain,
                error: err, absolute_error: Math.abs(err), squared_error: err * err,
                percentage_error: null, bias: err
             });
             continue;
        }

        if (name === 'snow_amount' || name === 'freezing_rain_amount') {
             continue;
        }

        // Standard Variables
        const obsVal = obs[obsKey as keyof Observation] as number;
        const fcstVal = forecast[name as keyof Forecast] as number;
        if (obsVal == null || fcstVal == null) continue;

        let error: number;
        
        if (name === 'wind_direction_10m') {
            const oSpd = obs.wind_speed || 0;
            const fSpd = forecast.wind_speed_10m || 0;

            if (oSpd < 5 && fSpd < 5) continue;

            let diff = fcstVal - obsVal;
            while (diff < -180) diff += 360;
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

export async function calculateModelVariableStats(bucketName: BucketName): Promise<ModelVariableStats[] | null> {
    const [minHours, maxHours] = LEAD_TIME_BUCKETS[bucketName];
    const records: Verification[] = await db.getAll('verification', 'by_lead_time', IDBKeyRange.bound(minHours, maxHours));

    if (records.length === 0) return null;

    const stats: Record<string, any> = {};
    for (const rec of records) {
        // Outlier rejection
        if (rec.variable !== 'pressure_msl' && !rec.variable.includes('occurrence') && !rec.variable.includes('probability') && rec.absolute_error > 2000) continue;
        
        const key = `${rec.model_id}::${rec.variable}`;
        if (!stats[key]) {
            stats[key] = { model_id: rec.model_id, variable: rec.variable, sum_ae: 0, sum_se: 0, sum_bias: 0, sum_perc_error: 0, sum_obs: 0, sum_fcst: 0, sum_obs_sq: 0, sum_fcst_sq: 0, sum_obs_fcst: 0, count: 0, perc_count: 0 };
        }
        stats[key].sum_ae += rec.absolute_error;
        stats[key].sum_se += rec.squared_error;
        stats[key].sum_bias += rec.bias;
        stats[key].sum_obs += rec.observed_value;
        stats[key].sum_fcst += rec.forecast_value;
        stats[key].sum_obs_sq += rec.observed_value ** 2;
        stats[key].sum_fcst_sq += rec.forecast_value ** 2;
        stats[key].sum_obs_fcst += rec.observed_value * rec.forecast_value;
        stats[key].count++;
    }

    return Object.values(stats).map(s => {
        const n = s.count;
        if (n === 0) return null;
        const mse = s.sum_se / n;
        return {
            model_id: s.model_id, variable: s.variable, n: n,
            mae: s.sum_ae / n, mse: mse, rmse: Math.sqrt(mse), bias: s.sum_bias / n,
            mape: null, correlation: null, index_of_agreement: null, skill_score: null
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
        const sum = statsForVar.reduce((acc, val) => acc + val.mae, 0);
        consensusMae[variable] = sum / statsForVar.length;
    });

    const scores: ModelVariableStats[] = presentModels.map(modelId => {
        let sumScore = 0;
        let varCount = 0;
        let totalN = 0;

        presentVariables.forEach(variable => {
            const stat = validStats.find(s => s.model_id === modelId && s.variable === variable);
            
            if (stat) {
                const baseline = consensusMae[variable];
                const threshold = MIN_MAE_THRESHOLDS[variable] || MIN_MAE_THRESHOLDS['default'];
                const denom = Math.max(baseline, threshold);
                
                sumScore += (stat.mae / denom);
                totalN += stat.n;
            } else {
                sumScore += MISSING_DATA_PENALTY_SCORE;
            }
            varCount++;
        });

        const finalScore = varCount > 0 ? sumScore / varCount : MISSING_DATA_PENALTY_SCORE;
        const avgN = varCount > 0 ? Math.floor(totalN / varCount) : 0;

        return {
            model_id: modelId,
            variable: 'overall_score',
            mae: finalScore, 
            n: avgN,
            mse: 0, rmse: 0, bias: 0, mape: null, correlation: null, index_of_agreement: null, skill_score: null
        };
    });

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

    const filteredData = data.filter(d => (d.variable as string) === variableFilter);
    
    return filteredData.map(stats => ({
        model: stats.model_id,
        avg_mae: stats.mae,
        avg_rmse: stats.rmse,
        avg_mse: stats.mse,
        avg_bias: stats.bias,
        avg_corr: stats.correlation,
        avg_skill: stats.skill_score,
        total_verifications: stats.n
    })).sort((a, b) => a.avg_mae - b.avg_mae);
}

export async function getEarliestIssueTime(): Promise<number | null> {
    const dbConn = await db.openDB();
    return new Promise((resolve, reject) => {
        const tx = dbConn.transaction('forecasts', 'readonly');
        const store = tx.objectStore('forecasts');
        const index = store.index('by_issue_time');
        const req = index.openCursor(null, 'next'); // ascending
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                resolve(cursor.value.issue_time);
            } else {
                resolve(null);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

export async function cleanupOldData(): Promise<void> {
    const cutoff = Date.now() - 730 * 24 * 3600 * 1000;
    log('[CLEANUP] Deleting records older than 2 years...');
    const deletedCount = await db.cleanupOldDataDB(cutoff);
    log(`[CLEANUP] Deleted ~${deletedCount} old records.`);
}
