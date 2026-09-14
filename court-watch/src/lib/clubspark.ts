// The JSON the BookByDate page loads. No login needed for any of the three
// venues (checked 2026-09-14).

export interface RawSession {
  ID: string;
  Category: number; // 1000 = bookable, 0 = booked, 2000 coaching, 4000 club, 7000 maintenance, 8000 closed
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

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchVenueSessions(
  segment: string,
  startDate: string,
  endDate: string,
  fetchFn: FetchLike = fetch,
): Promise<VenueSessionsResponse> {
  const res = await fetchFn(sessionsUrl(segment, startDate, endDate), {
    headers: { Accept: 'application/json', 'User-Agent': 'court-watch/1.0 (personal availability check)' },
  });
  if (!res.ok) throw new Error(`ClubSpark ${segment} responded ${res.status}`);
  const json = (await res.json()) as Partial<VenueSessionsResponse>;
  if (!json || !Array.isArray(json.Resources)) {
    throw new Error(`Unexpected response for ${segment}: no Resources`);
  }
  return json as VenueSessionsResponse;
}
