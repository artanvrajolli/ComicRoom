const path = require('path');
const { getAiSettings } = require('../config/ai');

const MAX_ANALYZED_PAGES = 5;
// Reasoning models count their thinking against max_tokens; 900 was often used
// up before the JSON answer was written (empty reply, finish_reason "length").
const METADATA_MAX_TOKENS = 4000;
const MAX_IMAGE_DIMENSION = 1200;
const MAX_DESCRIPTION_LENGTH = 5000;
const REQUEST_TIMEOUT_MS = 60000;
const METADATA_PROMPT = [
    'You identify comic book metadata from the first pages of a scanned comic.',
    'The images usually include the cover, title page, and credits.',
    'Return ONLY a JSON object with exactly these keys:',
    '{"title": "...", "author": "...", "description": "..."}',
    'Every key is optional: when a value is not clearly visible, use an empty string "".',
    'Never use placeholders such as "Unknown", "N/A", "None", "Untitled" or "Not visible".',
    'Rules:',
    '- "title": the comic title as printed, including the series name and issue number when clearly shown. Keep it concise and do not include publisher names, file names or release/scan tags.',
    '- "author": the writer or creator shown in the credits, without labels like "Written by". Prefer the writer; for several writers join the names with ", ".',
    '- "description": a short spoiler-free synopsis in 2-4 sentences, based only on the cover, title page, or a synopsis printed on these pages. Do not invent plot details.',
    '- Do not guess. It is fine for all three values to be empty.'
].join('\n');

const FIELD_ALIASES = {
    title: ['title', 'name', 'comic_title', 'comicTitle', 'series'],
    author: ['author', 'authors', 'writer', 'writers', 'creator', 'creators', 'artist'],
    description: ['description', 'synopsis', 'summary', 'blurb', 'plot']
};

// Values the model sometimes returns instead of an empty string.
const PLACEHOLDER_PATTERN = /^(n\/?a|na|none|null|nil|undefined|unknown|unk|untitled|unavailable|tbd|tba|empty|not applicable|no data|-+|\?+|\.+|_+)$/i;
const NOT_FOUND_PATTERN = /^(the )?(title|author|writer|creator|description|synopsis|summary|value|name|credits?)?\s*(is |are )?(not|no|none)\b.*\b(visible|available|legible|shown|found|provided|specified|clear|present|readable|listed|given|identified|determined|known)\b/i;
const NO_FIELD_PATTERN = /^(there is |there are )?no (title|author|writer|creator|credits?|description|synopsis|summary|plot)\b/i;

function isPlaceholder(value) {
    const bare = value.replace(/^["'`“”‘’\s]+|["'`“”‘’\s.!]+$/g, '');
    if (!bare) return true;
    if (PLACEHOLDER_PATTERN.test(bare)) return true;
    // Only treat sentence-like "not found" phrases as empty when they are short.
    return bare.length <= 120 && (NOT_FOUND_PATTERN.test(bare) || NO_FIELD_PATTERN.test(bare));
}

// Turns whatever the model sent for a field into a plain string.
function coerceToText(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
        const parts = value.map(coerceToText).map(v => v.trim()).filter(v => v && !isPlaceholder(v));
        return Array.from(new Set(parts)).join(', ');
    }
    if (typeof value === 'object') {
        return coerceToText(value.name || value.value || value.text || '');
    }
    return '';
}

function pickField(source, field) {
    for (const key of FIELD_ALIASES[field]) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const text = coerceToText(source[key]);
            if (text.trim()) return text;
        }
    }
    return '';
}

function normalizeMetadataValue(value, maxLength) {
    const text = String(value === null || value === undefined ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
        .trim();
    return isPlaceholder(text) ? '' : text.slice(0, maxLength);
}

function normalizeTitleValue(value) {
    const text = normalizeMetadataValue(value, 1000)
        .replace(/\.(cbz|cbr|zip|rar|pdf)$/i, '')
        .replace(/\s*[\(\[](digital|webrip|scan|c2c|zone-empire|empire)[^\)\]]*[\)\]]/gi, '')
        .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
        .trim();
    return isPlaceholder(text) ? '' : text;
}

function normalizeAuthorValue(value) {
    const text = normalizeMetadataValue(value, 1000)
        .replace(/^(written by|story by|script by|writer|writers|author|authors|creator|created by|by)\s*[:\-]?\s+/i, '')
        .replace(/\s*,\s*/g, ', ')
        .replace(/[,;\s]+$/, '')
        .trim();
    return isPlaceholder(text) ? '' : text;
}

function normalizeDescriptionValue(value, maxLength) {
    const text = String(value === null || value === undefined ? '' : value)
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return isPlaceholder(text) ? '' : text.slice(0, maxLength);
}

// Accepts {..}, [{..}], or {"metadata": {..}}-style wrappers.
function unwrapMetadataObject(parsed) {
    if (Array.isArray(parsed)) {
        parsed = parsed.find(item => item && typeof item === 'object');
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const hasKnownKey = obj => Object.keys(FIELD_ALIASES).some(f => FIELD_ALIASES[f].some(k => Object.prototype.hasOwnProperty.call(obj, k)));
    if (hasKnownKey(parsed)) return parsed;
    for (const value of Object.values(parsed)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && hasKnownKey(value)) return value;
    }
    return parsed;
}

// Last resort for truncated or slightly malformed JSON: read each "key": "value" pair.
function salvageFields(text) {
    const result = {};
    let matched = false;
    for (const field of Object.keys(FIELD_ALIASES)) {
        for (const key of FIELD_ALIASES[field]) {
            const re = new RegExp('"' + key + '"\\s*:\\s*(null|"((?:[^"\\\\]|\\\\.)*)("|$))', 'i');
            const m = text.match(re);
            if (m) {
                matched = true;
                if (m[1] !== 'null') {
                    let value;
                    try { value = JSON.parse('"' + m[2] + '"'); } catch (e) { value = m[2]; }
                    if (m[3] !== '"') {
                        // Cut off mid-value (reply truncated): keep complete sentences only.
                        const lastStop = Math.max(value.lastIndexOf('. '), value.lastIndexOf('! '), value.lastIndexOf('? '));
                        value = field === 'description' ? (lastStop > 0 ? value.slice(0, lastStop + 1) : '') : value;
                    }
                    result[field] = value;
                }
                break;
            }
        }
    }
    return matched ? result : null;
}

// Returns { title, author, description, found, missing } (values may be empty)
// or null when the reply contains no recognisable metadata object at all.
function parseMetadataContent(content) {
    if (typeof content !== 'string') {
        return null;
    }

    const cleaned = content
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    let parsed = null;

    try {
        parsed = JSON.parse(cleaned);
    } catch (error) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try { parsed = JSON.parse(match[0]); } catch (nestedError) { parsed = null; }
        }
        if (!parsed) {
            parsed = salvageFields(cleaned);
        }
    }

    const source = unwrapMetadataObject(parsed);
    if (!source) {
        return null;
    }

    const title = normalizeTitleValue(pickField(source, 'title'));
    const author = normalizeAuthorValue(pickField(source, 'author'));
    let description = normalizeDescriptionValue(pickField(source, 'description'), MAX_DESCRIPTION_LENGTH);
    if (description && title && description.toLowerCase() === title.toLowerCase()) {
        description = '';
    }

    const values = { title, author, description };
    const found = Object.keys(values).filter(key => values[key]);
    const missing = Object.keys(values).filter(key => !values[key]);
    return { title, author, description, found, missing };
}

async function encodePageAsDataUrl(filePath) {
    // Rendered in the isolated image worker: Skia has segfaulted in-process.
    const { renderImage } = require('./thumbnails');
    const buffer = await renderImage({ src: filePath, maxSide: MAX_IMAGE_DIMENSION, format: 'jpeg', quality: 82, background: '#ffffff' });
    return 'data:image/jpeg;base64,' + buffer.toString('base64');
}

function buildRequest(settings, text, images, maxTokens) {
    if (settings.provider === 'anthropic') {
        const content = [{ type: 'text', text: text }];
        images.forEach(function (dataUrl) {
            const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
            if (match) {
                content.push({
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] }
                });
            }
        });

        return {
            url: settings.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': settings.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: {
                model: settings.model,
                max_tokens: maxTokens,
                temperature: 0.1,
                messages: [{ role: 'user', content: content }]
            }
        };
    }

    const content = [{ type: 'text', text: text }];
    images.forEach(function (dataUrl) {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
    });

    return {
        url: settings.baseUrl,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.apiKey
        },
        body: {
            model: settings.model,
            messages: [{ role: 'user', content: content }],
            temperature: 0.1,
            max_tokens: maxTokens
        }
    };
}

function extractMessageText(provider, payload) {
    if (!payload) {
        return null;
    }

    if (provider === 'anthropic') {
        const parts = Array.isArray(payload.content) ? payload.content : [];
        const text = parts
            .filter(function (part) {
                return part && part.type === 'text' && typeof part.text === 'string';
            })
            .map(function (part) {
                return part.text;
            })
            .join('\n');
        return text || null;
    }

    const message = payload.choices && payload.choices[0] && payload.choices[0].message;
    if (!message) {
        return null;
    }

    if (typeof message.content === 'string') {
        return message.content;
    }

    if (Array.isArray(message.content)) {
        const text = message.content
            .filter(function (part) {
                return part && typeof part.text === 'string';
            })
            .map(function (part) {
                return part.text;
            })
            .join('\n');
        return text || null;
    }

    return null;
}

async function requestAi(settings, text, images, maxTokens) {
    const request = buildRequest(settings, text, images, maxTokens);
    let response;

    try {
        response = await fetch(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        return { ok: false, error: 'Request failed: ' + error.message };
    }

    const responseBody = await response.text();
    if (!response.ok) {
        return { ok: false, error: 'HTTP ' + response.status + ': ' + responseBody.slice(0, 300) };
    }

    let payload;
    try {
        payload = JSON.parse(responseBody);
    } catch (error) {
        return { ok: false, error: 'The AI response was not valid JSON.' };
    }

    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    return {
        ok: true,
        text: extractMessageText(settings.provider, payload),
        finishReason: (choice && choice.finish_reason) || (payload && payload.stop_reason) || ''
    };
}

async function detectComicMetadata(savedFolder, pageImages) {
    const settings = getAiSettings();
    if (!settings.apiKey) {
        console.log('AI metadata skipped: no AI API key is configured');
        return null;
    }

    const imageParts = [];
    const selectedPages = (Array.isArray(pageImages) ? pageImages : []).slice(0, MAX_ANALYZED_PAGES);

    for (const relativePath of selectedPages) {
        const absolutePath = path.join(process.cwd(), 'public', 'uploads', savedFolder, relativePath);
        try {
            imageParts.push(await encodePageAsDataUrl(absolutePath));
        } catch (error) {
            console.error(`AI metadata: skipped page ${relativePath}: ${error.message}`);
        }
    }

    if (imageParts.length === 0) {
        console.error('AI metadata: no readable pages found');
        return null;
    }

    const result = await requestAi(settings, METADATA_PROMPT, imageParts, METADATA_MAX_TOKENS);
    if (!result.ok) {
        console.error('AI metadata request failed: ' + result.error);
        return null;
    }

    const metadata = parseMetadataContent(result.text);
    if (!metadata) {
        const why = /^(length|max_tokens)$/.test(result.finishReason || '') ? ' (reply hit the token limit)' : '';
        console.error('AI metadata: reply had no usable JSON' + why + ': ' + String(result.text || '').slice(0, 200));
    }
    return metadata;
}

async function testAiConnection() {
    const settings = getAiSettings();
    if (!settings.apiKey) {
        return { ok: false, message: 'No API key is configured.' };
    }

    const result = await requestAi(settings, 'Reply with only the word OK.', [], 120);
    if (!result.ok) {
        return { ok: false, message: result.error };
    }

    const reply = result.text ? result.text.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return {
        ok: true,
        message: 'Connected to ' + settings.provider + ' / ' + settings.model + (reply ? ': ' + reply : '')
    };
}

// ---------- Bundle decision ----------
// "Is this archive several comics or one?" is a yes/no question, so each
// provider's cheapest fit is used instead of the metadata model:
//   commandcode -> Command Code decision model typesafe/jev (/provider/v1/systemone)
//   openai      -> OpenAI Decisions API, gpt-6-luna (/v1/decisions)
//   anthropic   -> Claude Haiku 5.5 (cheapest Claude model) with a JSON answer
// Override with AI_DECISION_MODEL. Returns null on any failure; callers fall
// back to file-name rules.
const DECISION_TIMEOUT_MS = 30000;
const DECISION_DEFAULT_MODELS = {
    commandcode: 'typesafe/jev',
    openai: 'gpt-6-luna',
    anthropic: 'claude-haiku-5-5'
};
const BUNDLE_INSTRUCTIONS = 'The state describes one uploaded comic archive: its file name and the groups of page images found inside '
    + '(folder names or page-name prefixes, with page counts). Is this a bundle of several separate comics, such as different issues, '
    + 'volumes or one-shots, that should each be listed as its own comic? Answer no when the groups are chapters, parts, scenes, covers, '
    + 'extras or variants of a single comic, or when the names do not suggest separate releases.';

function decisionUrl(settings) {
    const fallback = {
        commandcode: 'https://api.commandcode.ai/provider/v1/systemone',
        openai: 'https://api.openai.com/v1/decisions',
        anthropic: 'https://api.anthropic.com/v1/messages'
    }[settings.provider];
    const base = String(settings.baseUrl || '');
    if (settings.provider === 'commandcode' && /\/chat\/completions\/?$/.test(base)) {
        return base.replace(/\/chat\/completions\/?$/, '/systemone');
    }
    if (settings.provider === 'openai' && /\/chat\/completions\/?$/.test(base)) {
        return base.replace(/\/chat\/completions\/?$/, '/decisions');
    }
    if (settings.provider === 'anthropic' && /\/v1\/messages\/?$/.test(base)) {
        return base;
    }
    return fallback;
}

async function postJson(url, headers, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + text.slice(0, 200));
    }
    return JSON.parse(text);
}

function clampProbability(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(1, Math.max(0, number));
}

async function decideBundle(state) {
    const settings = getAiSettings();
    if (!settings.apiKey) return null;
    const model = String(process.env.AI_DECISION_MODEL || '').trim() || DECISION_DEFAULT_MODELS[settings.provider];
    if (!model) return null;
    const url = decisionUrl(settings);
    let probability = null;

    if (settings.provider === 'commandcode') {
        const payload = await postJson(url, { Authorization: 'Bearer ' + settings.apiKey }, {
            model: model,
            state: state,
            questions: { is_bundle: { type: 'noul', instructions: BUNDLE_INSTRUCTIONS } }
        });
        const answer = payload && payload.answers && payload.answers.is_bundle;
        probability = clampProbability(answer && answer.noul);
    } else if (settings.provider === 'openai') {
        const payload = await postJson(url, { Authorization: 'Bearer ' + settings.apiKey }, {
            model: model,
            input: JSON.stringify(state),
            questions: [{ type: 'predicate', name: 'is_bundle', instructions: BUNDLE_INSTRUCTIONS }]
        });
        const answers = payload && Array.isArray(payload.answers) ? payload.answers : [];
        const answer = answers.find(item => item && item.name === 'is_bundle');
        probability = clampProbability(answer && answer.probability);
    } else if (settings.provider === 'anthropic') {
        const payload = await postJson(url, { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' }, {
            model: model,
            max_tokens: 2000,
            output_config: { effort: 'low' },
            messages: [{
                role: 'user',
                content: BUNDLE_INSTRUCTIONS + '\n\nState:\n' + JSON.stringify(state)
                    + '\n\nReply with only JSON: {"is_bundle": true or false, "confidence": number from 0 to 1}.'
            }]
        });
        if (payload && payload.stop_reason === 'refusal') return null;
        const text = extractMessageText('anthropic', payload);
        const match = /\{[\s\S]*\}/.exec(String(text || ''));
        if (match) {
            const parsed = JSON.parse(match[0]);
            const confidence = clampProbability(parsed.confidence);
            if (typeof parsed.is_bundle === 'boolean') {
                const sure = confidence === null ? 0.75 : confidence;
                probability = parsed.is_bundle ? sure : 1 - sure;
            }
        }
    }

    if (probability === null) {
        throw new Error('decision reply had no usable answer');
    }
    return { isBundle: probability >= 0.5, probability: probability, model: model };
}

module.exports = { decideBundle, detectComicMetadata, testAiConnection, parseMetadataContent };
