
import type { BucketName } from './types';

export const DB_NAME = 'cyeg_weather_tracker';
export const DB_VERSION = 8; 

// Location: Edmonton International Airport (CYEG)
export const LOCATION = {
  lat: 53.30936,
  lon: -113.59532,
  name: 'CYEG'
};

export const ENDPOINTS = [
  {name: 'gem', days: 10},
  {name: 'gfs', days: 16},
  {name: 'ecmwf', days: 15},
  {name: 'dwd-icon', days: 7},
  {name: 'jma', days: 11},
  {name: 'cma', days: 10},
  {name: 'meteofrance', days: 4},
  {name: 'bom', days: 10}
];

export const HOURLY_VARS = 'temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,' +
  'wind_gusts_10m,pressure_msl,visibility,relative_humidity_2m,apparent_temperature,' +
  'precipitation,snowfall,snow_depth,rain,showers,weather_code,cloud_cover,' +
  'cloud_cover_low,cloud_cover_mid,cloud_cover_high,cape,precipitation_probability';

export const FORECAST_VARIABLES = [
    'temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m',
    'wind_gusts_10m', 'pressure_msl', 'visibility', 'relative_humidity_2m',
    'apparent_temperature', 'precipitation', 'snowfall', 'snow_depth',
    'rain', 'showers', 'weather_code', 'cloud_cover', 'cloud_cover_low',
    'cloud_cover_mid', 'cloud_cover_high', 'cape', 'precipitation_probability'
];

export const VERIFICATION_VARIABLES = [
    {name: 'temperature_2m', obsKey: 'temperature'},
    {name: 'dew_point_2m', obsKey: 'dewpoint'},
    {name: 'wind_speed_10m', obsKey: 'wind_speed'},
    {name: 'wind_direction_10m', obsKey: 'wind_dir'},
    {name: 'wind_gusts_10m', obsKey: 'wind_gust'},
    {name: 'visibility', obsKey: 'visibility'},
    {name: 'wind_vector', obsKey: 'null'},
    {name: 'precipitation', obsKey: 'precip_1h'},
    {name: 'precip_probability', obsKey: 'null'},
    {name: 'rain_amount', obsKey: 'null'},
    {name: 'snow_amount', obsKey: 'null'},
    {name: 'freezing_rain_amount', obsKey: 'null'},
    {name: 'rain_occurrence', obsKey: 'null'},
    {name: 'snow_occurrence', obsKey: 'null'},
    {name: 'freezing_rain_occurrence', obsKey: 'null'}
] as const;

export const VARIABLE_LABELS: Record<string, string> = {
    'overall_score': 'Overall Score (Normalized)',
    'temperature_2m': 'Temperature (°C)',
    'dew_point_2m': 'Dew Point (°C)',
    'wind_speed_10m': 'Wind Speed (km/h)',
    'wind_direction_10m': 'Wind Direction (°)',
    'wind_gusts_10m': 'Wind Gusts (km/h)',
    'visibility': 'Visibility (km)',
    'precipitation': 'Total Precip (mm)',
    'wind_vector': 'Wind Vector Error',
    'snowfall': 'Snowfall (cm)',
    'rain': 'Rain (mm)',
    'precipitation_probability': 'Precip Prob (Brier)',
    'precip_probability': 'Any Precip (Brier Score)',
    'rain_occurrence': 'Rain Event (Binary)',
    'snow_occurrence': 'Snow Event (Binary)',
    'freezing_rain_occurrence': 'Freezing Rain (Binary)',
    'rain_amount': 'Rain Amount (mm)',
    'snow_amount': 'Snow Amount (cm)',
    'freezing_rain_amount': 'Freezing Rain (mm)'
};

export const LEAD_TIME_BUCKETS: Record<BucketName, [number, number]> = {
  '24h': [-24, 24], // Allows verifying immediate past hours from current fetch
  '48h': [47, 49],
  '72h': [71, 73],
  '5day': [119, 121],
  '7day': [167, 169],
  '10day': [239, 241]
};

export const BUCKET_LABELS: Record<BucketName, string> = {
    '24h': 'Day 1 (Rolling)',
    '48h': '48 Hour',
    '72h': '72 Hour',
    '5day': '5 Day',
    '7day': '7 Day',
    '10day': '10 Day'
};

export const ALL_BUCKETS = Object.keys(LEAD_TIME_BUCKETS) as BucketName[];

export const parseUTC = (isoString: string): number => {
    // Fix for Safari/Cross-browser ISO parsing issues
    if (!isoString) return 0;
    let s = isoString.trim();
    if (!s.endsWith('Z') && !s.includes('+') && !s.includes('-')) {
        s += 'Z';
    }
    const t = new Date(s).getTime();
    return isNaN(t) ? 0 : t;
};

// Constants for Score Calibration
export const MIN_MAE_THRESHOLDS: Record<string, number> = {
    'default': 0.1,
    'temperature_2m': 0.5, // 0.5C
    'dew_point_2m': 0.5, // 0.5C
    'wind_speed_10m': 1.0, // 1 km/h
    'wind_direction_10m': 15.0, // 15 degrees (relaxed)
    'wind_gusts_10m': 1.5, // 1.5 km/h
    'wind_vector': 1.5, // 1.5 vector error
    'visibility': 1.0, // 1km
    'precipitation': 0.2, // 0.2mm
    'rain_amount': 0.2, // 0.2mm
    'snow_amount': 0.2, // 0.2cm
    'freezing_rain_amount': 0.2, // 0.2mm
    'rain_occurrence': 0.05, // 5%
    'snow_occurrence': 0.05, // 5%
    'freezing_rain_occurrence': 0.05, // 5%
    'precip_probability': 0.05 // 0.05 Brier
};

// Normalized Score Penalty for Missing Data
// 2.5 means "2.5x worse than the consensus/threshold error"
export const MISSING_DATA_PENALTY_SCORE = 2.5;
