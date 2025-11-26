
import type { BucketName } from './types';

export const DB_NAME = 'cyeg_weather_tracker';
// Bump to 18 to force schema refresh
export const DB_VERSION = 18; 

// Location: Edmonton International Airport (CYEG)
export const LOCATION = {
  lat: 53.30936,
  lon: -113.59532,
  name: 'CYEG'
};

// --- Variable Sets ---

// 1. Base Variables: Supported by ALL models (Safe)
// Minimal set to ensure fetching succeeds even for limited models
export const BASE_VARS = 'temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,' +
  'wind_gusts_10m,pressure_msl,relative_humidity_2m,apparent_temperature,' +
  'precipitation,snowfall,rain,showers,weather_code,cloud_cover';

// 2. Full Suite: For robust models (ECMWF, GFS) that support everything
// Includes Visibility, Ceiling (Cloud Base), CAPE, Precip Probability
export const FULL_VARS = `${BASE_VARS},visibility,precipitation_probability,cloud_base_agl,cape`;

// 3. Limited Suite: For fragile models (MeteoFrance, BOM, etc.)
// Excludes variables often missing (Visibility, Ceiling, CAPE)
export const LIMITED_VARS = 'temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,precipitation,cloud_cover'; 

// Default export for generic use
export const HOURLY_VARS = FULL_VARS;

export interface ModelConfig {
  id: string;
  provider: string;
  apiModel?: string;
  days: number;
  label: string;
  vars?: string; // Explicit variable set to use
}

export const MODELS: ModelConfig[] = [
  // --- Core Global Models (Robust) ---
  { id: 'ecmwf', provider: 'ecmwf', days: 15, label: 'ECMWF IFS 0.25°', vars: FULL_VARS },
  { id: 'gfs', provider: 'gfs', days: 16, label: 'NOAA GFS', vars: FULL_VARS },
  { id: 'gem', provider: 'gem', days: 10, label: 'GEM Global', vars: FULL_VARS },
  { id: 'dwd-icon', provider: 'dwd-icon', days: 7, label: 'DWD ICON', vars: FULL_VARS },
  
  // --- Fragile / Limited Models ---
  { id: 'jma', provider: 'jma', days: 11, label: 'JMA GSM', vars: LIMITED_VARS },
  { id: 'cma', provider: 'cma', days: 10, label: 'CMA GRAPES', vars: LIMITED_VARS },
  { id: 'meteofrance', provider: 'meteofrance', days: 4, label: 'Météo-France ARPEGE', vars: LIMITED_VARS },
  
  // UKMO & BOM often fail with full vars or specific keys. We restrict them to LIMITED_VARS.
  { id: 'ukmo', provider: 'forecast', apiModel: 'ukmo_global_10km', days: 7, label: 'UK Met Office UKMO', vars: LIMITED_VARS },
  { id: 'bom', provider: 'bom', days: 10, label: 'BOM ACCESS-G', vars: LIMITED_VARS },
  
  // --- AI & Experimental Models ---
  // Strictly limited variables to prevent 400 errors
  { id: 'ecmwf-aifs', provider: 'forecast', apiModel: 'ecmwf_aifs025', days: 15, label: 'ECMWF AIFS', vars: LIMITED_VARS },
  { id: 'gfs-graphcast', provider: 'forecast', apiModel: 'gfs_graphcast025', days: 10, label: 'GFS GraphCast', vars: LIMITED_VARS },
  
  // --- Regional Models ---
  { id: 'gem-hrdps', provider: 'forecast', apiModel: 'gem_hrdps_continental', days: 2, label: 'GEM HRDPS', vars: LIMITED_VARS },
  // GEM Regional supports visibility, so we append it to BASE_VARS
  { id: 'gem-regional', provider: 'forecast', apiModel: 'gem_regional', days: 2, label: 'GEM Regional', vars: `${BASE_VARS},visibility` },

  // --- Additional Global Models ---
  // Fallback variants
  { id: 'ecmwf-04', provider: 'ecmwf', apiModel: 'ecmwf_ifs04', days: 10, label: 'ECMWF IFS 0.4°', vars: LIMITED_VARS },
  { id: 'gfs-025', provider: 'gfs', apiModel: 'gfs025', days: 16, label: 'NOAA GFS 0.25°', vars: FULL_VARS },
];

// Helper to check if a model supports a specific variable
export const isVariableSupported = (modelId: string, varName: string): boolean => {
    if (modelId.includes('_of_models')) return true;

    const model = MODELS.find(m => m.id === modelId);
    if (!model) return true;

    const vars = model.vars || HOURLY_VARS;
    return vars.includes(varName);
};

export const MODEL_LABELS: Record<string, string> = MODELS.reduce((acc, m) => ({...acc, [m.id]: m.label}), {
    'average_of_models': 'Average (Consensus)',
    'median_of_models': 'Median (Robust)'
} as Record<string, string>);

export const FORECAST_VARIABLES = [
  'temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m',
  'wind_gusts_10m', 'pressure_msl', 'visibility', 'relative_humidity_2m',
  'apparent_temperature', 'precipitation', 'snowfall', 'snow_depth',
  'rain', 'showers', 'weather_code', 'cloud_cover', 'precipitation_probability',
  'cloud_base_agl'
];

export const VERIFICATION_VARIABLES = [
  { name: 'temperature_2m', obsKey: 'temperature', threshold: 2 },
  { name: 'dew_point_2m', obsKey: 'dewpoint', threshold: 2 },
  { name: 'wind_speed_10m', obsKey: 'wind_speed', threshold: 5 },
  { name: 'wind_direction_10m', obsKey: 'wind_dir', threshold: 30 },
  { name: 'wind_gusts_10m', obsKey: 'wind_gust', threshold: 5 }, 
  { name: 'pressure_msl', obsKey: 'pressure_msl', threshold: 1 },
  { name: 'visibility', obsKey: 'visibility', threshold: 2000 },
  { name: 'cloud_base_agl', obsKey: 'ceiling_agl', threshold: 300 },
  { name: 'precipitation', obsKey: 'precip_1h', threshold: 0.5 },
  
  { name: 'wind_vector', obsKey: 'wind_vector', threshold: 5 },
  { name: 'precip_probability', obsKey: 'precip_probability', threshold: 0.2 },
  { name: 'rain_occurrence', obsKey: 'rain_occurrence', threshold: 0.5 },
  { name: 'snow_occurrence', obsKey: 'snow_occurrence', threshold: 0.5 },
  { name: 'freezing_rain_occurrence', obsKey: 'freezing_rain_occurrence', threshold: 0.5 },
  
  { name: 'rain_amount', obsKey: 'era_rain_amt', threshold: 0.5 },
  { name: 'snow_amount', obsKey: 'era_snow_amt', threshold: 0.5 }, 
  { name: 'freezing_rain_amount', obsKey: 'freezing_rain_amount', threshold: 0.5 } 
];

export const ALL_BUCKETS: BucketName[] = ['24h', '48h', '72h', '5day', '7day', '10day'];

export const BUCKET_LABELS: Record<BucketName, string> = {
  '24h': 'Day 1 (0-24h)',
  '48h': 'Day 2 (24-48h)',
  '72h': 'Day 3 (48-72h)',
  '5day': 'Day 5 (96-120h)',
  '7day': 'Day 7 (144-168h)',
  '10day': 'Day 10 (216-240h)'
};

export const LEAD_TIME_BUCKETS: Record<BucketName, [number, number]> = {
  '24h': [0, 24],
  '48h': [24, 48],
  '72h': [48, 72],
  '5day': [96, 120],
  '7day': [144, 168],
  '10day': [216, 240]
};

export const MIN_MAE_THRESHOLDS: Record<string, number> = {
    'temperature_2m': 1.0,
    'dew_point_2m': 1.0,
    'pressure_msl': 1.0,
    'wind_speed_10m': 2.5,
    'wind_gusts_10m': 3.5,
    'wind_direction_10m': 20,
    'visibility': 2000,
    'cloud_base_agl': 300,
    'precipitation': 0.2,
    'snow_amount': 0.2,
    'default': 1.0
};

export const MISSING_DATA_PENALTY_SCORE = 2.5;

export const VARIABLE_LABELS: Record<string, string> = {
  'overall_score': 'Overall Performance Score',
  'temperature_2m': 'Temperature (°C)',
  'dew_point_2m': 'Dew Point (°C)',
  'wind_speed_10m': 'Wind Speed (km/h)',
  'wind_direction_10m': 'Wind Direction (°)',
  'wind_gusts_10m': 'Wind Gusts (km/h)',
  'pressure_msl': 'Pressure (hPa)',
  'visibility': 'Visibility (m)',
  'cloud_base_agl': 'Ceiling Height (m)',
  'precipitation': 'Precipitation (mm)',
  'wind_vector': 'Wind Vector Error',
  'precip_probability': 'Precip Probability (Brier)',
  'rain_occurrence': 'Rain Occurrence',
  'snow_occurrence': 'Snow Occurrence',
  'freezing_rain_occurrence': 'Freezing Rain Occurrence',
  'rain_amount': 'Rain Amount (mm)',
  'snow_amount': 'Snow Amount (cm)',
  'freezing_rain_amount': 'Freezing Rain Amt (mm)'
};

export const parseUTC = (isoStr: string): number => {
    return new Date(isoStr + (isoStr.includes('Z') ? '' : 'Z')).getTime();
};
