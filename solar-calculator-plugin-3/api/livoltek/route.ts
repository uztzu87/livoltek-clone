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

// Step 1: Login with secuid and key to get a fresh token
async function livoltekLogin(): Promise<string> {
  const secuid = process.env.LIVOLTEK_SECURITY_ID;
  const rawKey = process.env.LIVOLTEK_API_KEY;

  if (!secuid || !rawKey) {
    throw new Error("Missing LIVOLTEK_SECURITY_ID or LIVOLTEK_API_KEY environment variables");
  }

  // FIX #1: Properly handle escaped characters in the API key
  // The key may contain literal "\r\n" strings that need to be converted to actual control chars
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

  // FIX #2: Token is directly in result.data, not result.data.data
  const token = result.data;
  if (!token || typeof token !== "string") {
    throw new Error(`No token returned from login. Got: ${JSON.stringify(result.data)}`);
  }

  console.log("Login successful, token length:", token.length);
  return token;
}

// Step 2: Make authenticated API requests using the token
async function livoltekRequest(
  token: string,
  endpoint: string,
  method: "GET" | "POST" = "GET",
  queryParams?: Record<string, string>
): Promise<Record<string, unknown>> {
  // userToken is required as query parameter for most endpoints
  const userToken = process.env.LIVOLTEK_USER_TOKEN;
  if (!userToken) {
    throw new Error("Missing LIVOLTEK_USER_TOKEN environment variable");
  }

  const params = new URLSearchParams({
    userToken,
    ...queryParams,
  });

  const url = `${LIVOLTEK_API_BASE}${endpoint}?${params.toString()}`;
  console.log(`Livoltek API: ${method} ${endpoint}`);

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // FIX #3: Token is passed directly, NOT as "Bearer <token>"
      Authorization: token,
    },
    cache: "no-store",
  });

  const text = await response.text();
  console.log(`API Response [${response.status}]:`, text.substring(0, 500));

  if (!response.ok) {
    throw new Error(`API error: ${response.status} - ${text.substring(0, 200)}`);
  }

  return JSON.parse(text);
}

// Fetch data from Livoltek API
async function fetchLivoltekData(): Promise<{ data: LivoltekSiteData; source: string }> {
  // Step 1: Login to get token
  const token = await livoltekLogin();

  // Step 2: Get site list
  const sitesResponse = await livoltekRequest(token, "/hess/api/userSites/list", "GET", {
    page: "1",
    size: "10",
  });

  console.log("Sites response:", JSON.stringify(sitesResponse, null, 2));

  // Extract sites from response - according to OpenAPI spec, it's in data.list
  const responseData = sitesResponse.data as Record<string, unknown> | undefined;
  if (!responseData) {
    throw new Error(`No data in response: ${JSON.stringify(sitesResponse)}`);
  }

  // Sites are in the 'list' property according to OpenAPI spec
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

  // FIX #4: Use correct field names from OpenAPI spec
  const siteId = String(site.powerStationId || "");
  const siteName = String(site.powerStationName || "Solar Site");

  if (!siteId) {
    throw new Error(`No powerStationId in site: ${JSON.stringify(site)}`);
  }

  console.log(`Found site: ${siteName} (${siteId})`);

  // Step 3: Get site overview
  const overviewResponse = await livoltekRequest(token, `/hess/api/site/${siteId}/overview`, "GET");
  const overview = (overviewResponse.data || {}) as Record<string, unknown>;

  // Step 4: Get current power flow
  const powerflowResponse = await livoltekRequest(token, `/hess/api/site/${siteId}/curPowerflow`, "GET");
  const powerflow = (powerflowResponse.data || {}) as Record<string, unknown>;

  // Step 5: Get ESS (battery) information
  let essData: Record<string, unknown> = {};
  try {
    const essResponse = await livoltekRequest(token, `/hess/api/site/${siteId}/ESS`, "GET");
    essData = (essResponse.data || {}) as Record<string, unknown>;
  } catch (e) {
    console.warn("Could not fetch ESS data:", e);
  }

  // Map power values using correct field names from OpenAPI spec
  const pvPower = parseFloat(String(powerflow.pvPower || 0)) / 1000; // Convert W to kW
  const batteryPower = parseFloat(String(powerflow.energyPower || 0)) / 1000;
  const gridPower = parseFloat(String(powerflow.powerGridPower || 0)) / 1000;
  const loadPower = parseFloat(String(powerflow.loadPower || 0)) / 1000;
  const batteryLevel = parseFloat(String(powerflow.energySoc || essData.currentSoc || 0));

  // Map energy values from overview (using correct field names)
  const todayEnergy = parseFloat(String(overview.eoutDaily || 0));
  const monthEnergy = parseFloat(String(overview.eoutMonth || 0));
  const totalEnergy = parseFloat(String(overview.eTotalToGrid || 0));

  // Calculate savings (if not provided by API)
  // Using average electricity rate - adjust for your region
  const electricityRate = parseFloat(process.env.ELECTRICITY_RATE || "0.17"); // USD per kWh
  const todaySavings = todayEnergy * electricityRate;
  const monthSavings = monthEnergy * electricityRate;
  const totalSavings = totalEnergy * electricityRate;

  // CO2 calculation: ~0.4 kg CO2 per kWh avoided
  const co2Factor = 0.4;
  const co2Avoided = totalEnergy * co2Factor;

  // Determine status based on powerStationStatus
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
