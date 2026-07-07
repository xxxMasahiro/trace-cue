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

export async function createSourceIntakeProposal(payload) {
  const body = await postJson('/api/source-intake/proposal', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.source_intake;
}

export async function setDisplayLanguage(payload) {
  const body = await postJson('/api/settings/display-language', payload);
  if (!body.ok || body.envelope.status === 'error') {
    throw new Error(body.message);
  }
  return body.envelope.data.display_language;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    cache: 'no-store',
    body: JSON.stringify(payload)
  });
  const envelope = await response.json();
  const message = envelope.errors?.[0]?.message ?? envelope.error?.message ?? 'The local action could not be completed.';
  return {
    ok: response.ok,
    envelope,
    message
  };
}
