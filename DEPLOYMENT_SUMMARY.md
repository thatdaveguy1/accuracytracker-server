# Deployment Summary

**Status**: ✅ Deployed Successfully (Multi-Container)
**Platform**: Google Cloud Platform (Compute Engine - Ubuntu)
**IP Address**: `34.42.184.112` (Static)

## Applications

### 1. Accuracy Tracker (Main)
*   **URL**: [http://34.42.184.112](http://34.42.184.112)
*   **Port**: 80
*   **Container**: `accuracytracker`
*   **Database**: SQLite (Persisted in `/home/dave/data/weather.db`)

### 2. Boreas Weather (Secondary)
*   **URL**: [http://34.42.184.112:8080](http://34.42.184.112:8080)
*   **Port**: 8080
*   **Container**: `boreas`

## Maintenance

### SSH Access
```bash
gcloud compute ssh weather-tracker-vm --zone=us-central1-a
```

### View Logs
```bash
# All services
gcloud compute ssh weather-tracker-vm --zone=us-central1-a --command="sudo docker compose logs -f"

# Specific service
gcloud compute ssh weather-tracker-vm --zone=us-central1-a --command="sudo docker compose logs -f accuracytracker"
```

### Deploy Updates
1.  **Build & Push** (Locally):
    ```bash
    # Accuracy Tracker
    docker build --platform linux/amd64 -t gcr.io/accuracytracker-server/weather-tracker:latest .
    docker push gcr.io/accuracytracker-server/weather-tracker:latest

    # Boreas
    cd ../Boreas-Weather
    docker build --platform linux/amd64 -t gcr.io/accuracytracker-server/boreas:latest .
    docker push gcr.io/accuracytracker-server/boreas:latest
    ```

2.  **Update Server**:
    ```bash
    gcloud compute ssh weather-tracker-vm --zone=us-central1-a --command="sudo docker compose pull && sudo docker compose up -d"
    ```
