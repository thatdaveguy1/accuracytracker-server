
export type BucketName = '24h' | '48h' | '72h' | '5day' | '7day' | '10day';

/**
 * Represents a single hour of forecast data from a model.
 */
export interface Forecast {
  id: string;
  model_id: string;
  issue_time: number;
  valid_time: number;
  temperature_2m: number | null;
  dew_point_2m: number | null;
  wind_speed_10m: number | null;
  wind_direction_10m: number | null;
  wind_gusts_10m: number | null;
  pressure_msl: number | null;
  visibility: number | null;
  relative_humidity_2m: number | null;
  apparent_temperature: number | null;
  precipitation: number | null;
  snowfall: number | null;
  snow_depth: number | null;
  rain: number | null;
  showers: number | null;
  weather_code: number | null;
  cloud_cover: number | null;
  cloud_cover_low: number | null;
  cloud_cover_mid: number | null;
  cloud_cover_high: number | null;
  cape: number | null;
  precipitation_probability: number | null;
  cloud_base_agl: number | null;
}

/**
 * Represents a ground truth observation.
 * Combines METAR (station) data with ERA5 (reanalysis) data for missing metrics.
 */
export interface Observation {
  obs_time: number;
  report_type: 'METAR' | 'SPECI' | 'SYNTHETIC';
  
  // Direct METAR Readings
  temperature: number | null;
  dewpoint: number | null;
  wind_dir: number | null;
  wind_speed: number | null;
  wind_gust: number | null;
  visibility: number | null;
  pressure_msl: number | null;
  raw_text: string;
  
  // Parsed METAR Fields
  precip_1h: number | null; // mm (Often unreliable in METAR)
  ceiling_agl: number | null; // meters
  weather_codes: string[]; // e.g. ['RA', 'SN', 'BR']
  
  // ERA5 / Reanalysis Fallbacks
  // Used when METAR does not provide specific amounts (Snow) or is missing data (Gusts)
  era_snow_amt: number | null;
  era_precip_amt: number | null;
  era_rain_amt: number | null;
  era_wind_gust: number | null;
}

export interface Verification {
  key: string;
  model_id: string;
  variable: string;
  valid_time: number;
  issue_time: number;
  lead_time_hours: number;
  forecast_value: number;
  observed_value: number;
  error: number;
  absolute_error: number;
  squared_error: number;
  percentage_error: number | null;
  bias: number;
}

export interface ModelVariableStats {
  model_id: string;
  variable: string;
  mae: number;
  mse: number;
  rmse: number;
  bias: number;
  mape: number | null;
  correlation: number | null;
  index_of_agreement: number | null;
  skill_score: number | null;
  std_error: number | null; // Standard Error of the Mean (for Significance)
  n: number;
}

export interface LeaderboardRow {
  model: string;
  avg_mae: number;
  avg_rmse: number;
  avg_mse: number;
  avg_bias: number;
  avg_corr: number | null;
  avg_skill: number | null;
  std_error: number | null;
  total_verifications: number;
}
