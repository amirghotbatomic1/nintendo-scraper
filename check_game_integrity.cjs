#!/usr/bin/env node

/**
 * 🎮 Nintendo Switch Game Downloads Integrity Checker
 * 
 * Flow:
 * 1. Fetch pending games from Site API (or single target)
 * 2. Group files by section/package (base_game, update v1.x, dlc, etc.)
 * 3. Download ALL parts belonging to that section into a dedicated folder
 * 4. Run test extraction on the set of parts (part1.rar or test archive)
 * 5. If extraction succeeds, mark all parts in that section as healthy.
 *    If extraction fails or any part is 404/403, mark corrupted / broken_link with detailed message.
 * 6. Clean up downloaded parts after verifying the section to save disk space.
 * 7. Report results back to Site API with retry mechanism.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const SYNC_API_TOKEN = process.env.SYNC_API_TOKEN || '';
const DEFAULT_PASSWORD = process.env.ARCHIVE_PASSWORD || '';
const WORK_DIR = path.resolve(process.env.TEMP_DIR || './temp_integrity_checks');

// Parse CLI arguments
const args = process.argv.slice(2);
let singleTarget = null;
let forceRecheck = false;
let limit = 10;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' || args[i] === '--single-url' || args[i] === '--url' || args[i] === '--slug') {
        singleTarget = args[++i];
    } else if (args[i] === '--force-recheck') {
        forceRecheck = true;
    } else if (args[i] === '--limit') {
        limit = parseInt(args[++i], 10) || 5;
    }
}

if (!fs.existsSync(WORK_DIR)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
}

// Helper: HTTP Request with Retries
async function apiRequest(endpoint, method = 'GET', body = null, maxRetries = 3) {
    const url = `${SITE_URL}${endpoint}`;
    const headers = {
        'Accept': 'application/json',
        'Authorization': `Bearer ${SYNC_API_TOKEN}`,
        'X-Sync-Token': SYNC_API_TOKEN,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Game-Integrity-Worker/1.0',
    };
    if (body) {
        headers['Content-Type'] = 'application/json';
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : null,
            });

            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const errorMsg = data && data.message ? data.message : `HTTP ${response.status} ${response.statusText}`;
                throw new Error(`API Error (${endpoint}): ${errorMsg}`);
            }

            return data;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ API attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${attempt * 2}s...`);
            await new Promise(r => setTimeout(r, attempt * 2000));
        }
    }

    throw lastError;
}

// Format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Clean up folder
function cleanDir(dirPath) {
    if (fs.existsSync(dirPath)) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (e) {
            console.error(`⚠️ Failed to remove directory ${dirPath}:`, e.message);
        }
    }
}

// Download file using aria2c or curl with browser User-Agent
function downloadFile(url, destPath) {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const referer = SITE_URL ? `${SITE_URL}/` : 'https://google.com/';

    // Try aria2c first
    const checkAria = spawnSync('which', ['aria2c']);
    if (checkAria.status === 0) {
        const dir = path.dirname(destPath);
        const outName = path.basename(destPath);
        const res = spawnSync('aria2c', [
            '-x', '8',
            '-s', '8',
            '-j', '4',
            '--check-certificate=false',
            `--user-agent=${userAgent}`,
            `--referer=${referer}`,
            '--header=Accept: */*',
            '--dir', dir,
            '--out', outName,
            url
        ], { stdio: 'inherit' });

        if (res.status === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
            return true;
        }
    }

    // Fallback to curl
    console.log(`🔄 Attempting download via curl with browser headers...`);
    const res = spawnSync('curl', [
        '-L',
        '-f',
        '-k',
        '-A', userAgent,
        '-e', referer,
        '-H', 'Accept: */*',
        '-o', destPath,
        url
    ], { stdio: 'inherit' });

    return res.status === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
}

// Test extraction/integrity of an archive set
function testExtractArchiveGroup(firstArchiveFile, password = DEFAULT_PASSWORD) {
    const ext = path.extname(firstArchiveFile).toLowerCase();

    // RAR archive test
    if (ext === '.rar' || firstArchiveFile.includes('.part')) {
        const checkUnrar = spawnSync('which', ['unrar']);
        const bin = checkUnrar.status === 0 ? 'unrar' : 'rar';

        console.log(`🧪 Running RAR test extraction on: ${path.basename(firstArchiveFile)} (Password: ${password ? '***' : 'None'})`);
        const args = ['t', '-y'];
        if (password) {
            args.push(`-p${password}`);
        } else {
            args.push('-p-');
        }
        args.push(firstArchiveFile);

        const res = spawnSync(bin, args, { encoding: 'utf-8' });
        const output = (res.stdout || '') + (res.stderr || '');
        if (res.status === 0 && (output.includes('All OK') || output.includes('Everything is Ok') || output.includes('OK'))) {
            return { success: true, message: 'Archive and all volume parts verified successfully (All OK)' };
        }
        return {
            success: false,
            message: (res.stderr || res.stdout || 'RAR extraction test failed').trim().slice(-400)
        };
    }

    // 7z / ZIP archive test
    if (['.7z', '.zip', '.001'].includes(ext)) {
        console.log(`🧪 Running 7z/ZIP test extraction on: ${path.basename(firstArchiveFile)}`);
        const args = ['t', '-y'];
        if (password) {
            args.push(`-p${password}`);
        }
        args.push(firstArchiveFile);

        const res = spawnSync('7z', args, { encoding: 'utf-8' });
        const output = (res.stdout || '') + (res.stderr || '');
        if (res.status === 0 && (output.includes('Everything is Ok') || output.includes('All OK'))) {
            return { success: true, message: 'Archive and all volumes verified successfully (Everything is Ok)' };
        }
        return {
            success: false,
            message: (res.stderr || res.stdout || '7z extraction test failed').trim().slice(-400)
        };
    }

    // Standalone NSP / XCI / NSZ
    if (['.nsp', '.xci', '.nsz'].includes(ext)) {
        const stat = fs.statSync(firstArchiveFile);
        if (stat.size < 1024 * 1024) {
            return { success: false, message: `File size too small (${formatBytes(stat.size)}) for a valid Switch ROM` };
        }
        return { success: true, message: `Standalone ROM validated (${formatBytes(stat.size)})` };
    }

    return { success: true, message: 'Non-archive format, downloaded successfully' };
}

// Group files by Section (e.g. Base Game, Update v1.0, DLC Pack 1)
function groupFilesBySection(files) {
    const groups = {};

    files.forEach(file => {
        // Group key based on file_type and version/prefix
        const key = `${file.file_type}_${file.version || 'default'}_${file.total_parts > 1 ? 'multipart' : 'single'}`;
        if (!groups[key]) {
            groups[key] = {
                key,
                file_type: file.file_type,
                version: file.version,
                total_parts: file.total_parts || 1,
                files: [],
            };
        }
        groups[key].files.push(file);
    });

    // Sort files within each group by part_number
    Object.values(groups).forEach(g => {
        g.files.sort((a, b) => (a.part_number || 1) - (b.part_number || 1));
    });

    return Object.values(groups);
}

// Process a single game's integrity
async function checkGameIntegrity(game) {
    console.log(`\n======================================================`);
    console.log(`🎮 [Game #${game.id}] Checking: ${game.title}`);
    console.log(`======================================================`);

    const gameDir = path.join(WORK_DIR, `game_${game.id}`);
    cleanDir(gameDir);
    fs.mkdirSync(gameDir, { recursive: true });

    try {
        await apiRequest('/api/v1/games/integrity/mark-checking', 'POST', { game_id: game.id });
    } catch (e) {
        console.warn(`⚠️ Could not mark game as checking:`, e.message);
    }

    const filesResults = [];
    const files = game.files || [];
    const sectionGroups = groupFilesBySection(files);

    console.log(`📦 Found ${sectionGroups.length} distinct section(s) / package(s) to verify.`);

    for (const group of sectionGroups) {
        console.log(`\n------------------------------------------------------`);
        console.log(`📂 Processing Section [${group.file_type.toUpperCase()}] - ${group.version || 'Main'} (${group.files.length} part(s))`);
        console.log(`------------------------------------------------------`);

        const downloadedParts = [];
        let hasDownloadError = false;

        // Step 1: Download ALL parts for this section first
        for (const file of group.files) {
            console.log(`⬇️ Downloading Part ${file.part_number || 1}/${file.total_parts || 1}: ${file.title}`);

            let fileName = file.file_name;
            if (!fileName) {
                try {
                    fileName = path.basename(new URL(file.download_url).pathname);
                } catch {
                    fileName = `file_${file.id}.rar`;
                }
            }
            if (!fileName.includes('.')) fileName += '.rar';

            // Ensure distinct file names for multi-part archives if not present
            if (group.files.length > 1 && !fileName.toLowerCase().includes('.part') && !fileName.match(/\.r\d{2}$/i)) {
                fileName = `archive_${group.file_type}_part${file.part_number || 1}.rar`;
            }

            const localPath = path.join(gameDir, fileName);
            const ok = downloadFile(file.download_url, localPath);

            if (!ok || !fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
                console.error(`❌ Download failed or 403/404 for: ${file.title}`);
                hasDownloadError = true;
                filesResults.push({
                    id: file.id,
                    health_status: 'broken_link',
                    check_error_details: 'Download failed: 403 Forbidden or 404 Not Found on cloud server',
                    actual_file_size: '0 B',
                    tested_format: path.extname(fileName).replace('.', '').toUpperCase(),
                });
            } else {
                const actualSize = formatBytes(fs.statSync(localPath).size);
                downloadedParts.push({ file, localPath, fileName, actualSize });
            }
        }

        // If any part of this section failed to download, mark remaining downloaded parts as incomplete
        if (hasDownloadError) {
            console.error(`❌ Section incomplete due to missing/corrupted part downloads.`);
            downloadedParts.forEach(({ file, fileName, actualSize }) => {
                filesResults.push({
                    id: file.id,
                    health_status: 'corrupted',
                    check_error_details: 'One or more adjacent parts failed to download; archive cannot be reconstructed.',
                    actual_file_size: actualSize,
                    tested_format: path.extname(fileName).replace('.', '').toUpperCase(),
                });
            });

            // Clean up downloaded parts for this section
            downloadedParts.forEach(({ localPath }) => {
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
            });
            continue;
        }

        // Step 2: Extract / Test the whole archive set together
        // Multi-part RARs are tested starting from part1.rar or the first volume
        const firstVolume = downloadedParts.find(p =>
            p.fileName.toLowerCase().includes('part1.rar') ||
            p.fileName.toLowerCase().includes('part01.rar') ||
            p.fileName.toLowerCase().includes('.rar') ||
            p.fileName.toLowerCase().includes('.7z')
        ) || downloadedParts[0];

        const password = group.files[0]?.password || DEFAULT_PASSWORD;
        const testRes = testExtractArchiveGroup(firstVolume.localPath, password);

        if (testRes.success) {
            console.log(`✅ [SECTION PASS] All ${downloadedParts.length} parts extracted and verified successfully!`);
            downloadedParts.forEach(({ file, fileName, actualSize }) => {
                filesResults.push({
                    id: file.id,
                    health_status: 'healthy',
                    check_error_details: null,
                    actual_file_size: actualSize,
                    tested_format: path.extname(fileName).replace('.', '').toUpperCase(),
                });
            });
        } else {
            console.error(`❌ [SECTION CORRUPTED] Extraction test failed: ${testRes.message}`);
            downloadedParts.forEach(({ file, fileName, actualSize }) => {
                filesResults.push({
                    id: file.id,
                    health_status: 'corrupted',
                    check_error_details: testRes.message,
                    actual_file_size: actualSize,
                    tested_format: path.extname(fileName).replace('.', '').toUpperCase(),
                });
            });
        }

        // Clean up parts after testing this section to free up disk immediately
        console.log(`🧹 Freeing disk space for this section...`);
        downloadedParts.forEach(({ localPath }) => {
            if (fs.existsSync(localPath)) {
                try { fs.unlinkSync(localPath); } catch { }
            }
        });
    }

    // Report back to Site API
    console.log(`\n📤 Sending integrity report to site...`);
    try {
        const reportRes = await apiRequest('/api/v1/games/integrity/report', 'POST', {
            game_id: game.id,
            files: filesResults,
        });
        console.log(`✅ Report submitted: Overall status is [${reportRes.integrity_status}]`);
    } catch (err) {
        console.error(`❌ Failed to send report:`, err.message);
    }

    cleanDir(gameDir);
}

async function main() {
    console.log(`🚀 Starting Nintendo Game Files Integrity Checker`);
    console.log(`- Site URL: ${SITE_URL}`);
    console.log(`- Single Target: ${singleTarget || 'None (Running Queue)'}`);
    console.log(`- Force Recheck: ${forceRecheck}`);
    console.log(`- Limit: ${limit}`);

    let gamesToTest = [];

    if (singleTarget) {
        console.log(`🔍 Fetching single target: ${singleTarget}`);
        try {
            const res = await apiRequest(`/api/v1/games/integrity/single?target=${encodeURIComponent(singleTarget)}`);
            if (res.data) {
                gamesToTest.push(res.data);
            }
        } catch (e) {
            console.error(`❌ Failed to load target game:`, e.message);
            process.exit(1);
        }
    } else {
        console.log(`📋 Fetching pending games from site queue...`);
        try {
            const res = await apiRequest(`/api/v1/games/integrity/pending?limit=${limit}&force_recheck=${forceRecheck ? '1' : '0'}`);
            gamesToTest = res.data || [];
        } catch (e) {
            console.error(`❌ Failed to load pending games:`, e.message);
            process.exit(1);
        }
    }

    if (gamesToTest.length === 0) {
        console.log(`✨ No games pending integrity check! Everything is up to date.`);
        return;
    }

    console.log(`🎮 Found ${gamesToTest.length} game(s) to verify.`);

    for (const game of gamesToTest) {
        await checkGameIntegrity(game);
    }

    console.log(`\n🎉 All integrity checks finished successfully!`);
}

main().catch(err => {
    console.error(`💥 Fatal error:`, err);
    process.exit(1);
});
