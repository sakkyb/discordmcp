import { request, type RequestLike } from './http.js';

// The JSON the BookByDate page loads. No login needed for any of the three
// venues (checked 2026-09-14).

export interface RawSession {
  ID: string;
  Category: number; // 0 = available (priced scheme cell), 1000 = booked, 2000 coaching, 4000 club, 7000 maintenance, 8000 closed
  SubCategory: number;
  Name: string;
  StartTime: number; // minutes since midnight
  EndTime: number;
  Interval: number;
  CourtCost: number;
}

export interface RawDay {
  Date: string; // "2026-09-19T00:00:00"
  Sessions: RawSession[];
}

export interface RawResource {
  ID: string;
  ResourceGroupID: string;
  Name: string; // "Court 1", "Crt 7 (No lights)", "Cricket Net 1"
  Category: number; // 1 = tennis court, 9 = cricket net
  Lighting: number; // 1 = floodlit
  Days: RawDay[];
}

export interface VenueSessionsResponse {
  TimeZone: string;
  Resources: RawResource[];
}

export const BASE = 'https://clubspark.lta.org.uk';

export function sessionsUrl(segment: string, startDate: string, endDate: string, nowMs = Date.now()): string {
  const q = new URLSearchParams({ resourceID: '', startDate, endDate, roleId: '', _: String(nowMs) });
  return `${BASE}/v0/VenueBooking/${segment}/GetVenueSessions?${q}`;
}

// The page a person books on, opened at the given day.
export function bookingPageUrl(segment: string, date: string): string {
  return `${BASE}/${segment}/Booking/BookByDate#?date=${date}&role=guest`;
}

export async function fetchVenueSessions(
  segment: string,
  startDate: string,
  endDate: string,
  requestFn: RequestLike = request,
): Promise<VenueSessionsResponse> {
  const res = await requestFn(sessionsUrl(segment, startDate, endDate), {
    headers: { Accept: 'application/json', 'User-Agent': 'court-watch/1.0 (personal availability check)' },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`ClubSpark ${segment} responded ${res.status}`);
  let json: Partial<VenueSessionsResponse>;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error(`Unexpected response for ${segment}: not JSON`);
  }
  if (!json || !Array.isArray(json.Resources)) {
    throw new Error(`Unexpected response for ${segment}: no Resources`);
  }
  return json as VenueSessionsResponse;
}
