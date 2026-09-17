// Where the invalidation feed's socket connects, and with what — the two things
// supabase-js used to derive for us. The app only ever used supabase-js for its
// `.channel()`, which is a straight pass-through to the RealtimeClient it builds,
// so realtime.js now builds that client itself and skips 156 KB of auth, storage
// and REST code every tablet was parsing at boot. This file copies supabase-js
// 2.111.0's derivation exactly (SupabaseClient constructor + validateSupabaseUrl)
// and server/src/realtime-endpoint.test.js pins it against that version, so a
// tablet joins the same socket, with the same key, as it did before.
//
// Pure: no import.meta.env, no window — node --test imports it directly.

// supabase-js validateSupabaseUrl, message for message: a misconfigured
// VITE_SUPABASE_URL must fail as loudly, and as recognisably, as it always has.
function validateSupabaseUrl(supabaseUrl) {
  const trimmed = supabaseUrl == null ? undefined : String(supabaseUrl).trim();
  if (!trimmed) throw new Error('supabaseUrl is required.');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.');
  try {
    return new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  } catch {
    throw new Error('Invalid supabaseUrl: Provided URL is malformed.');
  }
}

// `https://<ref>.supabase.co` → `wss://<ref>.supabase.co/realtime/v1`.
// RealtimeClient appends `/websocket?apikey=…&vsn=2.0.0` itself.
export function realtimeEndpoint(supabaseUrl) {
  const url = new URL('realtime/v1', validateSupabaseUrl(supabaseUrl));
  url.protocol = url.protocol.replace('http', 'ws');
  return url.href;
}

// The options supabase-js handed RealtimeClient that still mean anything on a
// socket. `headers` is ignored on a WebSocket and `fetch` only serves REST
// broadcast sends, which this app never makes. The token: supabase-js asked its
// auth client for a session and, with persistSession off there never is one,
// fell back to the key — so the key is the token, and no auth client is needed.
export function realtimeClientOptions(supabaseKey) {
  if (!supabaseKey) throw new Error('supabaseKey is required.');
  return {
    params: { apikey: supabaseKey },
    accessToken: async () => supabaseKey,
  };
}
