import { NextResponse } from "next/server";

// Disable Vercel caching - we need fresh data every request
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Livoltek API servers
const LIVOLTEK_GLOBAL_SERVER = "https://api.livoltek-portal.com:8081";
const LIVOLTEK_EMEA_SERVER = "https://api-eu.livoltek-portal.com:8081";

// Use EMEA server if configured, otherwise global
const LIVOLTEK_API_BASE = process.env.LIVOLTEK_USE_EMEA === "true"
  ? LIVOLTEK_EMEA_SERVER
  : LIVOLTEK_GLOBAL_SERVER;

interface LivoltekSiteData {
  siteId: string;
  siteName: string;
  currentPower: number;
  todayEnergy: number;
  monthEnergy: number;
  totalEnergy: number;
  todaySavings: number;
  monthSavings: number;
  totalSavings: number;
  co2Avoided: number;
  batteryLevel?: number;
  batteryPower?: number;
  gridPower?: number;
  loadPower?: number;
  pvPower?: number;
  status: "online" | "offline" | "warning";
  lastUpdate: string;
}

interface LoginResult {
  authToken: string;
  userToken: string;
}

// Helper to decode JWT payload (without verification - just for extracting data)
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = parts[1];
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

// Step 1: Login with secuid and key to get auth token and extract userToken
async function livoltekLogin(): Promise<LoginResult> {
  const secuid = process.env.LIVOLTEK_SECURITY_ID;
  const rawKey = process.env.LIVOLTEK_API_KEY;

  if (!secuid || !rawKey) {
    throw new Error("Missing LIVOLTEK_SECURITY_ID or LIVOLTEK_API_KEY environment variables");
  }

  // Handle escaped characters in the API key
  const key = rawKey.replace(/\\r/g, "\r").replace(/\\n/g, "\n");

  console.log("Logging in to Livoltek API...");
  console.log("Server:", LIVOLTEK_API_BASE);
  console.log("Security ID:", secuid);

  const response = await fetch(`${LIVOLTEK_API_BASE}/hess/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ secuid, key }),
    cache: "no-store",
  });

  const text = await response.text();
  console.log(`Login response [${response.status}]:`, text.substring(0, 500));

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} - ${text.substring(0, 200)}`);
  }

  const result = JSON.parse(text);

  if (result.code !== "200" || result.message !== "SUCCESS") {
    throw new Error(`Login failed: ${result.message || result.msg_code || "Unknown error"}`);
  }

  // FIX: Token is nested in result.data.data (not result.data)
  const authToken = result.data?.data;
  if (!authToken || typeof authToken !== "string") {
    throw new Error(`No token returned from login. Response structure: ${JSON.stringify(result.data)}`);
  }

  // Extract user ID from JWT payload to use as userToken
  const payload = decodeJwtPayload(authToken);
  console.log("JWT payload:", JSON.stringify(payload));

  // The user info is stored as a JSON string in the "user" field
  let userToken = process.env.LIVOLTEK_USER_TOKEN || "";

  if (payload.user && typeof payload.user === "string") {
    try {
      const userInfo = JSON.parse(payload.user);
      // Use the user's ID as userToken
      userToken = userInfo.id || userToken;
      console.log("Extracted userToken from JWT:", userToken);
    } catch (e) {
      console.warn("Could not parse user info from JWT:", e);
    }
  }

  if (!userToken) {
    throw new Error("Could not determine userToken. Set LIVOLTEK_USER_TOKEN env variable.");
  }

  console.log("Login successful!");
  console.log("Auth token length:", authToken.length);
  console.log("User token:", userToken);

  return { authToken, userToken };
}

// Step 2: Make authenticated API requests
async function livoltekRequest(
  authToken: string,
  userToken: string,
  endpoint: string,
  method: "GET" | "POST" = "GET",
  queryParams?: Record<string, string>
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    userToken,
    ...queryParams,
  });

  const url = `${LIVOLTEK_API_BASE}${endpoint}?${params.toString()}`;
  console.log(`Livoltek API: ${method} ${endpoint}`);
  console.log(`Using userToken: ${userToken}`);

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Auth token goes in Authorization header (no Bearer prefix)
      Authorization: authToken,
    },
    cache: "no-store",
  });

  const text = await response.text();
  console.log(`API Response [${response.status}]:`, text.substring(0, 500));

  if (!response.ok) {
    throw new Error(`API error: ${response.status} - ${text.substring(0, 200)}`);
  }

  const json = JSON.parse(text);

  // Check for API-level errors
  if (json.code && json.code !== "200" && json.code !== "operate.success") {
    throw new Error(`API error: ${json.message || json.code}`);
  }

  return json;
}

// Fetch data from Livoltek API
async function fetchLivoltekData(): Promise<{ data: LivoltekSiteData; source: string }> {
  // Step 1: Login to get tokens
  const { authToken, userToken } = await livoltekLogin();

  // Step 2: Get site list
  const sitesResponse = await livoltekRequest(authToken, userToken, "/hess/api/userSites/list", "GET", {
    page: "1",
    size: "10",
  });

  console.log("Sites response:", JSON.stringify(sitesResponse, null, 2));

  // Extract sites from response
  const responseData = sitesResponse.data as Record<string, unknown> | undefined;
  if (!responseData) {
    throw new Error(`No data in response: ${JSON.stringify(sitesResponse)}`);
  }

  // Sites are in the 'list' property
  let sites: Array<Record<string, unknown>> = [];
  if (responseData.list && Array.isArray(responseData.list)) {
    sites = responseData.list as Array<Record<string, unknown>>;
  } else if (Array.isArray(responseData)) {
    sites = responseData;
  }

  if (sites.length === 0) {
    throw new Error(`No sites found: ${JSON.stringify(responseData).substring(0, 500)}`);
  }

  const site = sites[0];

  // Use correct field names from OpenAPI spec
  const siteId = String(site.powerStationId || "");
  const siteName = String(site.powerStationName || "Solar Site");

  if (!siteId) {
    throw new Error(`No powerStationId in site: ${JSON.stringify(site)}`);
  }

  console.log(`Found site: ${siteName} (${siteId})`);

  // Step 3: Get site overview
  const overviewResponse = await livoltekRequest(authToken, userToken, `/hess/api/site/${siteId}/overview`, "GET");
  const overview = (overviewResponse.data || {}) as Record<string, unknown>;

  // Step 4: Get current power flow
  const powerflowResponse = await livoltekRequest(authToken, userToken, `/hess/api/site/${siteId}/curPowerflow`, "GET");
  const powerflow = (powerflowResponse.data || {}) as Record<string, unknown>;

  // Step 5: Get ESS (battery) information
  let essData: Record<string, unknown> = {};
  try {
    const essResponse = await livoltekRequest(authToken, userToken, `/hess/api/site/${siteId}/ESS`, "GET");
    essData = (essResponse.data || {}) as Record<string, unknown>;
  } catch (e) {
    console.warn("Could not fetch ESS data:", e);
  }

  // Map power values (convert W to kW)
  const pvPower = parseFloat(String(powerflow.pvPower || 0)) / 1000;
  const batteryPower = parseFloat(String(powerflow.energyPower || 0)) / 1000;
  const gridPower = parseFloat(String(powerflow.powerGridPower || 0)) / 1000;
  const loadPower = parseFloat(String(powerflow.loadPower || 0)) / 1000;
  const batteryLevel = parseFloat(String(powerflow.energySoc || essData.currentSoc || 0));

  // Map energy values from overview
  const todayEnergy = parseFloat(String(overview.eoutDaily || 0));
  const monthEnergy = parseFloat(String(overview.eoutMonth || 0));
  const totalEnergy = parseFloat(String(overview.eTotalToGrid || 0));

  // Calculate savings
  const electricityRate = parseFloat(process.env.ELECTRICITY_RATE || "0.17");
  const todaySavings = todayEnergy * electricityRate;
  const monthSavings = monthEnergy * electricityRate;
  const totalSavings = totalEnergy * electricityRate;

  // CO2 calculation: ~0.4 kg CO2 per kWh avoided
  const co2Avoided = totalEnergy * 0.4;

  // Determine status
  const statusValue = site.powerStationStatus;
  let status: "online" | "offline" | "warning" = "offline";
  if (statusValue === 1 || pvPower > 0) {
    status = "online";
  } else if (statusValue === 2) {
    status = "warning";
  }

  return {
    data: {
      siteId,
      siteName,
      currentPower: pvPower,
      todayEnergy,
      monthEnergy,
      totalEnergy,
      todaySavings,
      monthSavings,
      totalSavings,
      co2Avoided,
      batteryLevel: batteryLevel > 0 ? batteryLevel : undefined,
      batteryPower: batteryPower !== 0 ? batteryPower : undefined,
      gridPower: gridPower !== 0 ? gridPower : undefined,
      loadPower: loadPower > 0 ? loadPower : undefined,
      pvPower: pvPower > 0 ? pvPower : undefined,
      status,
      lastUpdate: new Date().toISOString(),
    },
    source: `${LIVOLTEK_API_BASE}/hess/api`,
  };
}

export async function GET() {
  try {
    const result = await fetchLivoltekData();

    return NextResponse.json({
      success: true,
      data: result.data,
      source: result.source,
      cached: false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Livoltek API Error:", errorMessage);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        debug: {
          apiBase: LIVOLTEK_API_BASE,
          hasSecuid: !!process.env.LIVOLTEK_SECURITY_ID,
          hasKey: !!process.env.LIVOLTEK_API_KEY,
          hasUserToken: !!process.env.LIVOLTEK_USER_TOKEN,
        },
      },
      { status: 500 }
    );
  }
}
