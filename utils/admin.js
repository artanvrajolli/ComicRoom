function getAdminIdentifiers() {
    return String(process.env.ADMIN_USERNAMES || '')
        .split(',')
        .map(function (value) {
            return value.trim().toLowerCase();
        })
        .filter(Boolean);
}

function isAdmin(user) {
    if (!user) {
        return false;
    }

    const identifiers = getAdminIdentifiers();
    if (identifiers.length === 0) {
        return false;
    }

    const candidates = [user.username, user.email]
        .filter(Boolean)
        .map(function (value) {
            return String(value).toLowerCase();
        });

    return candidates.some(function (value) {
        return identifiers.indexOf(value) !== -1;
    });
}

module.exports = { getAdminIdentifiers, isAdmin };
