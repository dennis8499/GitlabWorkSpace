/** Pure configuration: importing this helper never connects to a server. */
export function liveEnvironments(environment = process.env) {
  const rawUrl = environment.GLW_CE16_URL ?? 'http://127.0.0.1:8930';
  let ce16Url;
  try { ce16Url = new URL(rawUrl); } catch { throw new Error('GLW_CE16_URL must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(ce16Url.protocol) || ce16Url.username || ce16Url.password || ce16Url.search || ce16Url.hash) {
    throw new Error('GLW_CE16_URL must use HTTP or HTTPS without embedded credentials, query or fragment.');
  }
  const version = environment.GLW_CE16_EXPECTED_VERSION ?? '16.11.10';
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.trim() !== version) throw new Error('GLW_CE16_EXPECTED_VERSION must be an exact major.minor.patch version.');
  return {
    ce19: { url: 'http://127.0.0.1:8929', tokenName: 'GLW_CE19_TOKEN', version: '19.4.1' },
    ce16: { url: ce16Url.href.replace(/\/$/, ''), tokenName: 'GLW_CE16_TOKEN', version }
  };
}
