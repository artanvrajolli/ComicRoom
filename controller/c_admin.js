const { isAdmin } = require('../utils/admin');
const { PROVIDER_DEFAULTS, getAiSettings, saveAiSettings } = require('../config/ai');
const { testAiConnection } = require('../utils/aiMetadata');

function requireAdmin(req, res, next) {
    if (typeof req.session.userData == 'undefined') {
        req.session.msg = 'Please log in to access the admin panel.';
        res.redirect('/login');
        return;
    }

    if (!isAdmin(req.session.userData)) {
        res.status(403);
        res.render('v_404', {
            msg: 'Admin access only.',
            userData: req.session.userData
        });
        return;
    }

    next();
}

function maskApiKey(apiKey) {
    if (!apiKey) {
        return '';
    }
    if (apiKey.length <= 12) {
        return 'configured';
    }
    return apiKey.slice(0, 6) + '...' + apiKey.slice(-4);
}

const getAdminPage = (req, res) => {
    const msg = req.session.msg;
    req.session.msg = '';
    const settings = getAiSettings();

    res.render('v_admin', {
        userData: req.session.userData,
        msg: msg,
        settings: settings,
        providerDefaults: PROVIDER_DEFAULTS,
        maskedKey: maskApiKey(settings.apiKey)
    });
};

const postAdminSettings = (req, res) => {
    try {
        saveAiSettings({
            provider: req.body.provider,
            model: req.body.model,
            baseUrl: req.body.baseUrl,
            apiKey: req.body.apiKey,
            clearKey: req.body.clearKey === '1'
        });
        req.session.msg = 'AI settings saved.';
    } catch (error) {
        req.session.msg = error.message;
    }

    res.redirect('/admin');
};

const postAdminTest = async (req, res) => {
    try {
        const result = await testAiConnection();
        res.json(result);
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
};

module.exports = {
    requireAdmin,
    getAdminPage,
    postAdminSettings,
    postAdminTest
};
