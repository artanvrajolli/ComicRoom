const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_FILE = process.env.AI_SETTINGS_FILE
    ? path.resolve(process.env.AI_SETTINGS_FILE)
    : path.join(os.homedir(), '.config', 'comicroom', 'ai-settings.json');
const PROVIDER_DEFAULTS = {
    commandcode: {
        model: 'deepseek/deepseek-v4.1-flash',
        baseUrl: 'https://api.commandcode.ai/provider/v1/chat/completions'
    },
    openai: {
        model: 'gpt-4.1-mini',
        baseUrl: 'https://api.openai.com/v1/chat/completions'
    },
    anthropic: {
        // Cheapest current Claude model; reads covers/credits well enough for metadata.
        model: 'claude-haiku-5-5',
        baseUrl: 'https://api.anthropic.com/v1/messages'
    }
};
const ENV_KEYS = {
    commandcode: 'COMMANDCODE_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY'
};

function isProvider(provider) {
    return Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, provider);
}

function readSavedSettings() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) {
            return null;
        }

        const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.error('Could not read AI settings:', error.message);
        return null;
    }
}

function writeSavedSettings(settings) {
    const settingsDirectory = path.dirname(SETTINGS_FILE);
    fs.mkdirSync(settingsDirectory, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(settingsDirectory, 0o700);
    } catch (error) {}

    const temporaryFile = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryFile, SETTINGS_FILE);
    try {
        fs.chmodSync(SETTINGS_FILE, 0o600);
    } catch (error) {}
}

function getEnvProvider() {
    const requested = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
    if (isProvider(requested) && process.env[ENV_KEYS[requested]]) {
        return requested;
    }

    const available = Object.keys(ENV_KEYS).find(function (provider) {
        return Boolean(process.env[ENV_KEYS[provider]]);
    });

    if (available) {
        return available;
    }

    return isProvider(requested) ? requested : 'commandcode';
}

function getAiSettings() {
    const saved = readSavedSettings();
    const savedProvider = saved && typeof saved.provider === 'string' ? saved.provider.trim().toLowerCase() : '';
    const provider = isProvider(savedProvider) ? savedProvider : getEnvProvider();
    const defaults = PROVIDER_DEFAULTS[provider];

    const savedModel = saved && typeof saved.model === 'string' ? saved.model.trim() : '';
    const savedBaseUrl = saved && typeof saved.baseUrl === 'string' ? saved.baseUrl.trim() : '';
    const envModel = provider === 'commandcode'
        ? String(process.env.COMMANDCODE_MODEL || '').trim()
        : String(process.env.AI_MODEL || '').trim();
    const envBaseUrl = provider === 'commandcode'
        ? String(process.env.COMMANDCODE_API_URL || '').trim()
        : String(process.env.AI_BASE_URL || '').trim();

    const savedKey = saved && typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '';
    const envKey = String(process.env[ENV_KEYS[provider]] || '').trim();
    const apiKey = savedKey || envKey;

    return {
        provider: provider,
        model: savedModel || envModel || defaults.model,
        baseUrl: savedBaseUrl || envBaseUrl || defaults.baseUrl,
        apiKey: apiKey,
        source: savedKey ? 'settings' : (envKey ? 'environment' : 'none')
    };
}

function saveAiSettings(input) {
    const provider = String(input.provider || '').trim().toLowerCase();
    if (!isProvider(provider)) {
        throw new Error('Unsupported AI provider.');
    }

    const existing = readSavedSettings() || {};
    const sameProvider = String(existing.provider || '').trim().toLowerCase() === provider;
    const incomingKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const clearKey = Boolean(input.clearKey);
    let apiKey = '';

    if (incomingKey) {
        apiKey = incomingKey;
    } else if (!clearKey && sameProvider && typeof existing.apiKey === 'string') {
        apiKey = existing.apiKey;
    }

    const defaults = PROVIDER_DEFAULTS[provider];
    const settings = {
        provider: provider,
        model: String(input.model || '').trim() || defaults.model,
        baseUrl: String(input.baseUrl || '').trim() || defaults.baseUrl
    };

    if (apiKey) {
        settings.apiKey = apiKey;
    }

    writeSavedSettings(settings);
    return getAiSettings();
}

function clearSavedApiKey() {
    const existing = readSavedSettings();
    if (!existing) {
        return getAiSettings();
    }

    const settings = {};
    if (existing.provider) {
        settings.provider = existing.provider;
    }
    if (existing.model) {
        settings.model = existing.model;
    }
    if (existing.baseUrl) {
        settings.baseUrl = existing.baseUrl;
    }

    writeSavedSettings(settings);
    return getAiSettings();
}

function isAiConfigured() {
    return Boolean(getAiSettings().apiKey);
}

module.exports = {
    PROVIDER_DEFAULTS,
    getAiSettings,
    saveAiSettings,
    clearSavedApiKey,
    isAiConfigured
};
