export async function fetchDashboard() {
  const response = await fetch('/api/dashboard', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  const body = await response.json();
  if (!response.ok || body.status === 'error') {
    const message = body.errors?.[0]?.message ?? body.error?.message ?? 'The local read-only dashboard could not be loaded.';
    throw new Error(message);
  }
  return body.data.control_center;
}
