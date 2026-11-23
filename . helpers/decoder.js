// helpers/decoder.js
exports.decrypt = function (data, key) {
    if (!key || !data) return null;
    const c = Array.from(key).map(char => char.charCodeAt(0));
    if (c.length === 0) return null;
    
    const s = Buffer.from(data, 'base64').toString('binary');
    let result = '';
    for (let i = 0; i < s.length; i++) {
        result += String.fromCharCode(s.charCodeAt(i) ^ c[i % c.length]);
    }
    return Buffer.from(result, 'binary').toString('utf8');
};
