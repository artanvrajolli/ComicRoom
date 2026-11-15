const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { getAiSettings } = require('../config/ai');

const MAX_ANALYZED_PAGES = 5;
const MAX_IMAGE_DIMENSION = 1200;
const REQUEST_TIMEOUT_MS = 60000;
const METADATA_PROMPT = [
    'You identify comic book metadata from the first pages of a scanned comic.',
    'The images usually include the cover, title page, and credits.',
    'Return ONLY a JSON object with exactly these keys:',
    '{"title": "...", "author": "..."}',
    'Rules:',
    '- "title": the comic title as printed, including the series name and issue number when clearly shown. Keep it concise and do not include publisher names or release/scan tags.',
    '- "author": the writer or creator shown in the credits. Prefer the writer. Use an empty string when no author is visible.',
    '- Do not guess. If the title is not legible, use an empty string for it.'
].join('\n');

function normalizeMetadataValue(value, maxLength) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function parseMetadataContent(content) {
    if (typeof content !== 'string') {
        return null;
    }

    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed = null;

    try {
        parsed = JSON.parse(cleaned);
    } catch (error) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) {
            return null;
        }
        try {
            parsed = JSON.parse(match[0]);
        } catch (nestedError) {
            return null;
        }
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const title = normalizeMetadataValue(parsed.title, 1000);
    const author = normalizeMetadataValue(parsed.author, 1000);
    if (!title && !author) {
        return null;
    }

    return { title, author };
}

async function encodePageAsDataUrl(filePath) {
    const image = await loadImage(filePath);
    const longestSide = Math.max(image.width, image.height);
    const scale = longestSide > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longestSide : 1;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return 'data:image/jpeg;base64,' + canvas.toBuffer('image/jpeg', 0.82).toString('base64');
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

    return {
        ok: true,
        text: extractMessageText(settings.provider, payload)
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

    const result = await requestAi(settings, METADATA_PROMPT, imageParts, 500);
    if (!result.ok) {
        console.error('AI metadata request failed: ' + result.error);
        return null;
    }

    return parseMetadataContent(result.text);
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

module.exports = { detectComicMetadata, testAiConnection };
