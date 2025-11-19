
export type BucketName = '24h' | '48h' | '72h' | '5day' | '7day' | '10day';

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
  // New fields
  precipitation_probability: number | null;
  cloud_base_agl: number | null;
}

export interface Observation {
  obs_time: number;
  report_type: 'METAR' | 'SPECI';
  temperature: number | null;
  dewpoint: number | null;
  wind_dir: number | null;
  wind_speed: number | null;
  wind_gust: number | null;
  visibility: number | null;
  pressure_msl: number | null;
  raw_text: string;
  // New fields
  precip_1h: number | null; // mm
  ceiling_agl: number | null; // meters (lowest BKN/OVC)
  weather_codes: string[]; // Parsed phenomena e.g. ['RA', 'SN', 'BR']
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
  total_verifications: number;
}
