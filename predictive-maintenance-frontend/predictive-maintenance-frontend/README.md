# Predictive Maintenance System – Frontend

A static, dependency-free web dashboard for an AI-powered predictive maintenance project. A user enters six machine sensor readings, the page sends them to an existing AWS API, and the failure prediction returned by the Random Forest model is displayed.

Built with plain **HTML5, CSS3 and vanilla JavaScript**. No framework, no build step, no Node.js, no backend server.

## Project overview

| | |
|---|---|
| Dataset | UCI AI4I 2020 Predictive Maintenance Dataset |
| Model | Random Forest Classifier (binary: failure / no failure) |
| Classification threshold | ≈ 0.58 (applied by the backend, never by the frontend) |
| Inputs | `type`, `air_temperature_k`, `process_temperature_k`, `rotational_speed_rpm`, `torque_nm`, `tool_wear_min` |
| Outputs | `failure_probability`, `prediction`, `status`, `risk_level`, `recommended_action` |

The frontend **does not** compute predictions, risk levels or actions. It displays exactly what the backend returns.

> **User-facing wording:** the page is written for end users. It deliberately shows no technical details (no model, dataset, AWS services, API or threshold information, and no backend status indicator). This README is the technical reference.

## Folder structure

```text
predictive-maintenance-frontend/
├── index.html   # Page structure: sidebar, overview, form, results
├── style.css    # Dark industrial theme, responsive layout
├── script.js    # Validation, API call, response parsing, rendering
└── README.md
```

## Run locally

No installation is needed.

**Option A – open the file:** double-click `index.html`. The API allows any origin (`*`), so this works, including from `file://`.

**Option B – tiny local server** (recommended, behaves like production):

```bash
cd predictive-maintenance-frontend
python3 -m http.server 8080
# then open http://localhost:8080
```

## How the frontend talks to AWS

```text
Browser (this app)
  → API Gateway HTTP API   POST /predict   (aoohc7ytsa, eu-north-1, $default stage)
  → AWS Lambda (Python 3.12)
  → SageMaker Runtime → SageMaker endpoint → Random Forest model
  → response back to the browser
```

**Request** – `POST https://aoohc7ytsa.execute-api.eu-north-1.amazonaws.com/predict`, header `Content-Type: application/json`, body with only the six original features, numbers sent as JSON numbers:

```json
{
  "type": "M",
  "air_temperature_k": 298.1,
  "process_temperature_k": 308.6,
  "rotational_speed_rpm": 1550,
  "torque_nm": 42.5,
  "tool_wear_min": 120
}
```

Engineered features (`temperature_difference_k`, `power_proxy`, `wear_torque_interaction`) and one-hot columns (`type_H`, `type_L`, `type_M`) are **not** sent; the backend's `prediction_utils.py` creates them.

**Response** – the application payload is:

```json
{
  "success": true,
  "data": {
    "failure_probability": 0.96,
    "prediction": 1,
    "status": "FAILURE",
    "risk_level": "HIGH",
    "recommended_action": "Inspect Machine"
  },
  "error": null
}
```

With an API Gateway Lambda proxy integration, the browser normally receives that JSON directly. If it instead receives the raw Lambda envelope (`{"statusCode":200,"headers":{…},"body":"{…}"}`), `script.js` parses the inner `body` string as well. Both shapes are handled.

### Prediction status vs. risk level

These are two separate outputs:

- **Prediction status** (`FAILURE` / `NO FAILURE`) – decided by the model threshold (≈ 0.58).
- **Risk level** (`LOW` / `MEDIUM` / `HIGH`) – fixed probability bands: below 0.40, 0.40 to below 0.70, 0.70 and above.

So a probability of 0.60 is `FAILURE` with `MEDIUM` risk. The UI shows them as separate badges.

## Change the API URL

The URL is defined **once**, at the top of `script.js`:

```js
const CONFIG = Object.freeze({
  API_URL: 'https://aoohc7ytsa.execute-api.eu-north-1.amazonaws.com/predict',
  ...
});
```

Edit `API_URL` and redeploy. If the API Gateway stage is not `$default`, include the stage name in the path (for example `.../prod/predict`).

## Deploy to Netlify (static site)

**Drag and drop (fastest)**
1. Sign in at <https://app.netlify.com>.
2. Go to **Sites → Add new site → Deploy manually**.
3. Drag the whole `predictive-maintenance-frontend` folder (or its ZIP) onto the upload area.
4. Netlify publishes it and gives you a `*.netlify.app` URL.

**From Git**
1. Push the folder to a GitHub repository.
2. In Netlify choose **Add new site → Import an existing project**.
3. Build command: *(leave empty)*. Publish directory: `.` (the repository root, or the folder containing `index.html`).

No environment variables, server or functions are needed. The browser calls API Gateway directly. The API URL is public and the frontend contains no AWS credentials or secrets.

## Important limitations and prerequisites for real predictions

- **The SageMaker endpoint may not be running.** To avoid AWS charges it was deleted after the first tests and is recreated only when needed. While it is down, the API cannot return predictions and the page shows a clear *"Prediction is temporarily unavailable"* message. **No fake or sample prediction is ever displayed.**
- Real end-to-end testing needs: the SageMaker endpoint **InService**, the Lambda function configured with that endpoint's name, and the API route `POST /predict` deployed. Remember to delete the endpoint again afterwards.
- The page sends **nothing** to the backend on load. Each request is sent only when the user presses **Predict Failure**, and repeated submissions are blocked while a request is in progress.
- A request to a freshly started or idle endpoint can be slow; the frontend waits up to 29 seconds (API Gateway's limit is 30 s) before reporting a timeout.
- CORS must allow the site's origin. It is currently `*` (all origins), with `content-type` allowed and methods `POST, OPTIONS`.
- This is decision support trained on a public dataset, not a guarantee about a machine's real condition. Client-side validation only checks that values are present, finite and non-negative; it makes no engineering or safety claims.

## Error handling summary

| Situation | What the user sees |
|---|---|
| Missing / invalid / negative input | Inline message under the field, no request sent |
| Network failure | "Connection problem" |
| Timeout (29 s) | "This is taking longer than expected" |
| 502 / 503 / 504, other 5xx, or SageMaker/endpoint errors | "Prediction is temporarily unavailable" |
| Invalid request body (400) | "Please check your input" |
| Route not found (404), throttled (429) | Short generic message (technical hint is written to the browser console only) |
| Malformed or unexpected response | "Something went wrong" (no result shown) |

On every failure the entered values stay in the form. No stack traces are shown.
