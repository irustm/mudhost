import { walk } from "@std/fs/walk";
import { relative } from "@std/path/relative";
import { AuthManager } from "./auth.ts";

interface DeployConfig {
    projectId: string;
    branch: string;
    commit: string;
    distDir: string;
    apiUrl: string;
    username?: string;
    password?: string;
    token?: string;
}

interface DeployFile {
    content: string;
    encoding: "utf8" | "base64";
}

const BINARY_EXTENSIONS = new Set([
    "wasm",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "eot",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "avif",
    "ico",
    "pdf",
    "zip",
    "gz",
    "br",
]);

function isValidUtf8(content: Uint8Array): boolean {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(content);
        return true;
    } catch {
        return false;
    }
}

function toBase64(content: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < content.length; i += chunkSize) {
        binary += String.fromCharCode(...content.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

function isBinaryFile(filePath: string, content: Uint8Array): boolean {
    const ext = filePath.split(".").pop()?.toLowerCase();
    if (ext && BINARY_EXTENSIONS.has(ext)) {
        return true;
    }
    return !isValidUtf8(content);
}

async function collectFiles(dir: string): Promise<Record<string, DeployFile>> {
    const files: Record<string, DeployFile> = {};

    try {
        console.log(`📁 Scanning directory: ${dir}`);

        for await (const entry of walk(dir)) {
            if (entry.isFile) {
                const relativePath = relative(dir, entry.path).replace(/\\/g, '/');

                try {
                    const content = await Deno.readFile(entry.path);
                    if (isBinaryFile(relativePath, content)) {
                        files[relativePath] = {
                            content: toBase64(content),
                            encoding: "base64",
                        };
                    } else {
                        files[relativePath] = {
                            content: new TextDecoder().decode(content),
                            encoding: "utf8",
                        };
                    }
                } catch (error) {
                    console.error(`  ❌ Error reading ${relativePath}:`, error);
                }
            }
        }

        console.log(`✅ Total files collected: ${Object.keys(files).length}`);
    } catch (error) {
        console.error(`❌ Error scanning directory ${dir}:`, error);
        throw error;
    }

    return files;
}

export async function deploy(config: DeployConfig) {
    try {
        const auth = new AuthManager(config);
        await auth.ensureAuth(config.username, config.password);

        console.log(`📦 Deploying ${config.projectId}...`);
        console.log(`📍 Source: ${config.distDir}`);

        const files = await collectFiles(config.distDir);

        if (Object.keys(files).length === 0) {
            throw new Error(`No files found in ${config.distDir}`);
        }

        console.log(`🚀 Sending deployment to ${config.apiUrl}...`);

        const response = await fetch(`${config.apiUrl}/api/deployments`, {
            method: 'POST',
            headers: auth.getAuthHeaders(),
            body: JSON.stringify({
                projectId: config.projectId,
                branch: config.branch || "main",
                commit: config.commit || "latest",
                files
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const deployment = await response.json();
        console.log(`✅ Deployment successful!`);
        console.log(`🔗 Preview URL: ${deployment.url}`);
        console.log(`📊 Files deployed: ${deployment.files.length}`);

        return deployment;
    } catch (error) {
        console.error('❌ Deployment failed:', error);
        Deno.exit(1);
    }
}