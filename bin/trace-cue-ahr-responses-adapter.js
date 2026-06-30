#!/usr/bin/env node
import {
  AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS,
  startAgenticHumanReviewResponsesAdapter
} from '../src/agentic-human-review-responses-adapter.js';

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  printHelp();
  process.exitCode = 0;
} else {
  try {
    const adapter = await startAgenticHumanReviewResponsesAdapter(parsed.options, {
      env: process.env
    });
    const payload = {
      status: 'listening',
      adapter: 'agentic-human-review-responses-adapter',
      url: adapter.url,
      endpoint_path: adapter.config.path,
      host: adapter.config.host,
      port: adapter.config.port,
      adapter_token_env: adapter.config.adapterTokenEnv,
      provider_api_key_env: adapter.config.providerApiKeyEnv,
      provider_api_key_fallback_env: adapter.config.providerApiKeyFallbackEnv,
      provider_endpoint_env: adapter.config.providerEndpointEnv,
      provider_model_env: adapter.config.providerModelEnv,
      timeout_ms: adapter.config.timeoutMs,
      provider_endpoint_value_printed: false,
      credential_values_printed: false,
      raw_provider_response_stored: false
    };
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Agentic Human Review Responses adapter listening at ${adapter.url}`);
      console.log(`Adapter token env: ${adapter.config.adapterTokenEnv}`);
      console.log(`Provider API key env: ${adapter.config.providerApiKeyEnv} or ${adapter.config.providerApiKeyFallbackEnv}`);
      console.log(`Provider model env: ${adapter.config.providerModelEnv}`);
      console.log(`Provider request timeout: ${adapter.config.timeoutMs} ms`);
    }
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => {
        await adapter.close();
        process.exitCode = 0;
      });
    }
  } catch (error) {
    const body = {
      status: 'error',
      error: {
        code: 'AHR_RESPONSES_ADAPTER_START_FAILED',
        message: error.message
      }
    };
    if (parsed.json) {
      console.error(JSON.stringify(body, null, 2));
    } else {
      console.error(`Agentic Human Review Responses adapter failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {};
  let help = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, value] = arg.slice(2).split(/=(.*)/s);
      assignOption(options, key, value);
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}.`);
      }
      assignOption(options, key, value);
      index += 1;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${arg}`);
  }
  return { help, json, options };
}

function assignOption(options, key, value) {
  const map = {
    host: 'host',
    port: 'port',
    path: 'path',
    'adapter-token-env': 'adapterTokenEnv',
    'provider-api-key-env': 'providerApiKeyEnv',
    'provider-api-key-fallback-env': 'providerApiKeyFallbackEnv',
    'provider-endpoint-env': 'providerEndpointEnv',
    'provider-model-env': 'providerModelEnv',
    'provider-endpoint': 'providerEndpoint',
    'provider-model': 'providerModel',
    'max-request-bytes': 'maxRequestBytes',
    'max-provider-response-bytes': 'maxProviderResponseBytes',
    timeout: 'timeoutMs',
    'contract-repair-attempts': 'contractRepairAttempts'
  };
  if (!map[key]) {
    throw new Error(`Unknown option: --${key}`);
  }
  options[map[key]] = value;
}

function printHelp() {
  console.log([
    'Usage: node ./bin/trace-cue-ahr-responses-adapter.js [options] [--json]',
    '',
    'Options:',
    `  --host <host>                         Loopback bind host. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.host}`,
    `  --port <port>                         Bind port. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.port}`,
    `  --path <path>                         Adapter endpoint path. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.path}`,
    `  --adapter-token-env <name>            Inbound bearer token env. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.adapterTokenEnv}`,
    `  --provider-api-key-env <name>         Provider API key env. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.providerApiKeyEnv}`,
    `  --provider-api-key-fallback-env <name> Provider API key fallback env. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.providerApiKeyFallbackEnv}`,
    `  --provider-endpoint-env <name>        Provider endpoint override env. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.providerEndpointEnv}`,
    `  --provider-model-env <name>           Provider model env. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.providerModelEnv}`,
    '  --provider-endpoint <url>             Provider endpoint default when env is unset.',
    '  --provider-model <id>                 Provider model default when env and request model are unset.',
    `  --timeout <ms>                        Provider request timeout. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.timeoutMs}`,
    `  --contract-repair-attempts <count>    Contract repair retries. Default: ${AGENTIC_HUMAN_REVIEW_RESPONSES_ADAPTER_DEFAULTS.contractRepairAttempts}`,
    '  --help                                Show this help.'
  ].join('\n'));
}
