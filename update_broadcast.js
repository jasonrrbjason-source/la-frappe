const fs = require('fs');

let content = fs.readFileSync('services/broadcast.js', 'utf8');

content = content.replace(
    /const currentBatchSize = .*?\n\n\s*for \(let i = 0; i < targets\.length; i \+= currentBatchSize\) {/g,
    `    const currentBatchSize = unifiedMediaList.length > 0 ? MEDIA_BATCH_SIZE : TEXT_BATCH_SIZE;

    let targetsToProcess = [...targets];
    
    // Seed Telegram file_ids by sending to the first user synchronously.
    // This allows subsequent batch sends to use file_ids (CDN pointers) instead of uploading massive buffers, avoiding memory and network crashes.
    if (unifiedMediaList.length > 0 && targetsToProcess.length > 0) {
        debugLog("[BC-SEED] Initializing file_id caching with first user...");
        let seederSuccess = false;
        while(targetsToProcess.length > 0 && !seederSuccess) {
            const seedUser = targetsToProcess.shift();
            const res = await sendToUser(seedUser, message, unifiedMediaList);
            if (res.success) {
                successCount++;
                seederSuccess = true;
                debugLog("[BC-SEED] Cached Telegram file_ids successfully.");
            } else {
                if (res.blocked) blockedCount++;
                else failedCount++;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Now loop through remaining targets
    for (let i = 0; i < targetsToProcess.length; i += currentBatchSize) {
        const batch = targetsToProcess.slice(i, i + currentBatchSize);`
);

content = content.replace(
    /async function sendToUser\(user, message, unifiedMediaList = \[\]\) {[\s\S]*?try {[\s\S]*?if \(unifiedMediaList\.length > 1\) {[\s\S]*?const mediaGroup = unifiedMediaList\.slice\(0, 10\)\.map\(\(m, i\) => \({[\s\S]*?type: m\.type,[\s\S]*?media: m\.url \|\| m\.source,[\s\S]*?\.\.\.\(i === 0 && caption \? { caption: caption, parse_mode: 'HTML' } : {}\)[\s\S]*?}\)\);[\s\S]*?debugLog\(\`\[BC-SEND\] MediaGroup \(\$\{mediaGroup\.length\}\) CDN Stream -> \$\{chatId\}\`\);[\s\S]*?await _bot\.telegram\.sendMediaGroup\(chatId, mediaGroup\);[\s\S]*?} else if \(unifiedMediaList\.length === 1\) {[\s\S]*?const m = unifiedMediaList\[0\];[\s\S]*?debugLog\(\`\[BC-SEND\] Single \$\{m\.type\.toUpperCase\(\)\} CDN Stream -> \$\{chatId\}\`\);[\s\S]*?if \(m\.type === 'video'\) {[\s\S]*?await _bot\.telegram\.sendVideo\(chatId, m\.url \|\| m\.source, { caption: caption, parse_mode: 'HTML' }\);[\s\S]*?} else {[\s\S]*?await _bot\.telegram\.sendPhoto\(chatId, m\.url \|\| m\.source, { caption: caption, parse_mode: 'HTML' }\);[\s\S]*?}[\s\S]*?} else {/g,
    `async function sendToUser(user, message, unifiedMediaList = []) {
    if (!_bot) {
        debugLog("[BC-ERROR] Bot non initialisé dans le service broadcast");
        return { success: false, error: "Bot non prêt" };
    }

    const chatId = user.platform_id;
    const caption = message ? (message.length > 1020 ? message.substring(0, 1017) + '...' : message) : '';

    try {
        if (unifiedMediaList.length > 1) {
            const mediaGroup = unifiedMediaList.slice(0, 10).map((m, i) => {
                let mediaObj = m.file_id;
                if (!mediaObj) {
                    if (m.source) {
                        // Pass buffer correctly to Telegraf
                        mediaObj = { source: m.source, filename: m.filename || 'media.mp4' };
                    } else if (m.url) {
                        mediaObj = m.url;
                    }
                }
                return {
                    type: m.type,
                    media: mediaObj,
                    ...(i === 0 && caption ? { caption: caption, parse_mode: 'HTML' } : {})
                };
            });

            debugLog(\`[BC-SEND] MediaGroup (\${mediaGroup.length}) -> \${chatId}\`);
            const msgs = await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
            
            // Cache file_ids
            msgs.forEach((msg, i) => {
                if (!unifiedMediaList[i].file_id) {
                    let fId = null;
                    if (msg.photo && msg.photo.length > 0) fId = msg.photo[msg.photo.length - 1].file_id;
                    else if (msg.video) fId = msg.video.file_id;
                    if (fId) unifiedMediaList[i].file_id = fId;
                }
            });
        } else if (unifiedMediaList.length === 1) {
            const mData = unifiedMediaList[0];
            let mediaObj = mData.file_id;
            if (!mediaObj) {
                if (mData.source) mediaObj = { source: mData.source, filename: mData.filename || 'media.mp4' };
                else if (mData.url) mediaObj = mData.url;
            }

            debugLog(\`[BC-SEND] Single \${mData.type.toUpperCase()} -> \${chatId}\`);
            if (mData.type === 'video') {
                const msg = await _bot.telegram.sendVideo(chatId, mediaObj, { caption: caption, parse_mode: 'HTML' });
                if (msg.video && !unifiedMediaList[0].file_id) unifiedMediaList[0].file_id = msg.video.file_id;
            } else {
                const msg = await _bot.telegram.sendPhoto(chatId, mediaObj, { caption: caption, parse_mode: 'HTML' });
                if (msg.photo && !unifiedMediaList[0].file_id) unifiedMediaList[0].file_id = msg.photo[msg.photo.length - 1].file_id;
            }
        } else {`
);

fs.writeFileSync('services/broadcast.js', content);
console.log('Update applied');
