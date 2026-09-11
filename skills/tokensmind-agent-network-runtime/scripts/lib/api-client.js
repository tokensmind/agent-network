import os from 'node:os';
import { createBrowserOpener } from './runtime/browser.js';
import { createConnector } from './runtime/connector.js';
import { DEFAULT_BASE_URL } from './runtime/constants.js';
import { createCredentialStore } from './runtime/credentialStore.js';
import { createHttpClient } from './runtime/httpClient.js';
import { normalizeBaseUrl } from './runtime/requestPolicy.js';
import { createWorkflowStore } from './workflow-store.js';

const CLIENT_NAME = 'TokensMind Agent Network Runtime';
const CLIENT_VERSION = '0.1.0';

export class AuthorizationRequiredError extends Error {
  constructor(verificationUrl) {
    super('Complete Agent Network authorization in the browser, then retry the action.');
    this.name = 'AuthorizationRequiredError';
    this.status = 'authorization_required';
    this.verificationUrl = verificationUrl;
  }
}

function reportingBrowser({ browser, writeEvent }) {
  return {
    async open(url) {
      try {
        await browser.open(url);
        writeEvent({ event: 'authorization_opened', verificationUrl: url });
      } catch (error) {
        writeEvent({ event: 'authorization_required', verificationUrl: url });
        throw new AuthorizationRequiredError(url, { cause: error });
      }
    },
  };
}

function resolveOptions(options) {
  const platform = options.platform ?? process.platform;
  return {
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    stateDir: options.stateDir,
    platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? os.homedir(),
    hostname: options.hostname ?? os.hostname(),
    browser: options.browser ?? createBrowserOpener({ platform }),
    http: options.http ?? createHttpClient(),
    store: options.store ?? null,
    writeEvent: options.writeEvent ?? (() => {}),
  };
}

export function createActionApi(options = {}) {
  const {
    baseUrl, stateDir, platform, env, homeDir, hostname, browser, http, store, writeEvent,
  } = resolveOptions(options);
  const origin = normalizeBaseUrl(baseUrl);
  const resolvedStore = store || createCredentialStore({ stateDir, origin, platform, env, homeDir });
  const workflowStore = createWorkflowStore({ stateDir, origin, platform, homeDir });
  const connector = createConnector({
    baseUrl: origin,
    browser: reportingBrowser({ browser, writeEvent }),
    client: {
      name: CLIENT_NAME,
      version: CLIENT_VERSION,
      deviceName: hostname,
      platform,
    },
    http,
    store: resolvedStore,
  });
  return {
    request: (request) => connector.execute(request),
    store: resolvedStore,
    workflowStore,
  };
}
