import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { ensureDir, emptyDir } from "https://deno.land/std@0.202.0/fs/mod.ts";
import { join, dirname } from "https://deno.land/std@0.202.0/path/mod.ts";
import { create, verify, getNumericDate } from "https://deno.land/x/djwt@v2.9/mod.ts";

interface Deployment {
    id: string;
    projectId: string;
    branch: string;
    commit: string;
    status: "building" | "ready" | "failed";
    createdAt: Date;
    expiresAt: Date;
    url: string;
    files: string[];
    createdBy?: string;
}

interface UploadedFile {
    content: string;
    encoding?: "utf8" | "base64";
}

interface User {
    id: string;
    username: string;
    passwordHash: string;
    role: "admin" | "user";
    createdAt: Date;
}

interface AuthConfig {
    jwtSecret: string;
    tokenExpiry: number;
}

class AuthService {
    private users = new Map<string, User>();
    private config: AuthConfig;
    private jwtKey: CryptoKey;

    constructor() {
        this.config = {
            jwtSecret: Deno.env.get('JWT_SECRET') || 'your-super-secret-jwt-key-change-in-production',
            tokenExpiry: 24 * 60 * 60,
        };

        this.initializeCryptoKey();
        this.initializeDefaultAdmin();
    }

    private async initializeCryptoKey() {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(this.config.jwtSecret);

        this.jwtKey = await crypto.subtle.importKey(
            "raw",
            keyData,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign", "verify"]
        );
    }

    private async initializeDefaultAdmin() {
        const adminUsername = Deno.env.get('ADMIN_USERNAME') || 'admin';
        const adminPassword = Deno.env.get('ADMIN_PASSWORD') || 'admin123';

        const adminUser: User = {
            id: '1',
            username: adminUsername,
            passwordHash: adminPassword,
            role: 'admin',
            createdAt: new Date()
        };

        this.users.set(adminUsername, adminUser);
        console.log(`👑 Default admin user created: ${adminUsername}`);
    }

    async authenticate(username: string, password: string): Promise<string | null> {
        const user = this.users.get(username);
        if (!user) {
            console.log(`❌ User not found: ${username}`);
            return null;
        }

        const isValid = password === user.passwordHash;
        if (!isValid) {
            console.log(`❌ Invalid password for user: ${username}`);
            return null;
        }

        try {
            const payload = {
                userId: user.id,
                username: user.username,
                role: user.role,
                exp: getNumericDate(this.config.tokenExpiry)
            };

            const token = await create({ alg: "HS256", typ: "JWT" }, payload, this.jwtKey);
            console.log(`✅ User authenticated: ${username}`);
            return token;
        } catch (error) {
            console.error('JWT creation error:', error);
            return null;
        }
    }

    async verifyToken(token: string): Promise<any | null> {
        try {
            const payload = await verify(token, this.jwtKey);
            return payload;
        } catch (error) {
            console.error('JWT verification error:', error);
            return null;
        }
    }

    async createUser(username: string, password: string, role: "admin" | "user" = "user"): Promise<boolean> {
        if (this.users.has(username)) {
            return false;
        }

        const user: User = {
            id: Math.random().toString(36).substr(2, 9),
            username,
            passwordHash: password,
            role,
            createdAt: new Date()
        };

        this.users.set(username, user);
        console.log(`✅ User created: ${username} (${role})`);
        return true;
    }

    getUser(username: string): User | undefined {
        return this.users.get(username);
    }

    listUsers(): User[] {
        return Array.from(this.users.values());
    }
}

class DeploymentService {
    private deployments = new Map<string, Deployment>();
    private baseDir = "./deployments";
    private cleanupInterval: number | null = null;

    constructor() {
        ensureDir(this.baseDir).catch(console.error);
        this.startCleanupJob();
    }

    private decodeBase64(content: string): Uint8Array {
        const binary = atob(content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    async createDeployment(
        projectId: string,
        branch: string,
        commit: string,
        files: Record<string, string | UploadedFile>,
        createdBy?: string
    ): Promise<Deployment> {
        let deploymentId = this.sanitizeDeploymentId(`${projectId}-${branch}-${Date.now()}`);

        if(branch === 'main' || branch === 'master') {
            deploymentId = this.sanitizeDeploymentId(`${projectId}`);
        }

        const deploymentDir = join(this.baseDir, deploymentId);

        await ensureDir(deploymentDir);

        const domain = Deno.env.get('DOMAIN') || 'localhost';

        let urls: string[];
        if (domain === 'localhost') {
            urls = [
                `http://${deploymentId}.${domain}/`,
                `http://${domain}/deploy/${deploymentId}/`,
                `http://${domain}/${deploymentId}/`
            ];
        } else {
            urls = [
                `http://${deploymentId}.${domain}/`,
                `http://${domain}/deploy/${deploymentId}/`,
                `http://${domain}/${deploymentId}/`
            ];
        }

        const mainUrl = urls[0];

        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);

        const deployment: Deployment = {
            id: deploymentId,
            projectId,
            branch,
            commit,
            status: "building",
            createdAt,
            expiresAt,
            url: mainUrl,
            urls: urls,
            files: [],
            createdBy
        };

        try {
            for (const [filePath, fileData] of Object.entries(files)) {
                const normalizedPath = filePath.replace(/\\/g, '/');
                const fullPath = join(deploymentDir, normalizedPath);

                const fileDir = dirname(fullPath);
                await ensureDir(fileDir);

                if (typeof fileData === "string") {
                    await Deno.writeTextFile(fullPath, fileData);
                } else if (fileData && typeof fileData.content === "string") {
                    if (fileData.encoding === "base64") {
                        await Deno.writeFile(fullPath, this.decodeBase64(fileData.content));
                    } else if (fileData.encoding === "utf8" || fileData.encoding === undefined) {
                        await Deno.writeTextFile(fullPath, fileData.content);
                    } else {
                        throw new Error(`Unsupported file encoding for ${normalizedPath}: ${fileData.encoding}`);
                    }
                } else {
                    throw new Error(`Invalid file payload for ${normalizedPath}`);
                }
                deployment.files.push(normalizedPath);
            }

            deployment.status = "ready";
            this.deployments.set(deploymentId, deployment);

            console.log(`✅ Deployment created by ${createdBy || 'unknown'}: ${deployment.url}`);
            console.log(`📁 Files deployed: ${deployment.files.length}`);

        } catch (error) {
            deployment.status = "failed";
            console.error("❌ Deployment failed:", error);
            throw error;
        }

        return deployment;
    }

    async deleteDeployment(id: string): Promise<boolean> {
        const deployment = this.deployments.get(id);
        if (!deployment) {
            return false;
        }

        try {
            const deploymentDir = join(this.baseDir, id);
            await emptyDir(deploymentDir);
            await Deno.remove(deploymentDir);

            this.deployments.delete(id);

            console.log(`🗑️ Deployment deleted: ${id}`);
            return true;
        } catch (error) {
            console.error(`❌ Error deleting deployment ${id}:`, error);
            return false;
        }
    }

    async cleanupExpiredDeployments(): Promise<number> {
        const now = new Date();
        let deletedCount = 0;

        for (const [id, deployment] of this.deployments.entries()) {
            if (deployment.expiresAt <= now) {
                try {
                    await this.deleteDeployment(id);
                    deletedCount++;
                } catch (error) {
                    console.error(`❌ Error cleaning up deployment ${id}:`, error);
                }
            }
        }

        if (deletedCount > 0) {
            console.log(`🧹 Cleaned up ${deletedCount} expired deployments`);
        }

        return deletedCount;
    }

    private startCleanupJob() {
        this.cleanupInterval = setInterval(async () => {
            console.log("🕒 Running scheduled cleanup...");
            await this.cleanupExpiredDeployments();
        }, 6 * 60 * 60 * 1000);

        console.log("✅ Auto-cleanup job started (every 6 hours)");
    }

    stopCleanupJob() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            console.log("🛑 Auto-cleanup job stopped");
        }
    }

    private sanitizeDeploymentId(id: string): string {
        return id.toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50);
    }

    getDeployment(id: string): Deployment | undefined {
        return this.deployments.get(id);
    }

    getProjectDeployments(projectId: string): Deployment[] {
        return Array.from(this.deployments.values())
            .filter(d => d.projectId === projectId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    getAllDeployments(): Deployment[] {
        return Array.from(this.deployments.values())
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    async forceCleanup(): Promise<{ deleted: number; errors: string[] }> {
        const result = { deleted: 0, errors: [] as string[] };
        const now = new Date();

        for (const [id, deployment] of this.deployments.entries()) {
            if (deployment.expiresAt <= now) {
                try {
                    await this.deleteDeployment(id);
                    result.deleted++;
                } catch (error) {
                    result.errors.push(`Failed to delete ${id}: ${error}`);
                }
            }
        }

        return result;
    }
}

const authService = new AuthService();
const deploymentService = new DeploymentService();
const app = new Application();
const router = new Router();

const authMiddleware = async (ctx: any, next: any) => {
    const publicRoutes = [
        '/api/auth/login',
        '/api/auth/register',
        '/preview/',
        '/main.js',
        '/main.css',
        '/index.html',
        '/favicon.ico'
    ];

    const isPublicRoute = publicRoutes.some(route => {
        if (route.endsWith('/')) {
            return ctx.request.url.pathname.startsWith(route);
        } else {
            return ctx.request.url.pathname === route ||
                ctx.request.url.pathname.startsWith(route + '/');
        }
    });

    const isStaticFile = ctx.request.url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map|json|txt|html)$/);

    if (isPublicRoute || isStaticFile) {
        return await next();
    }

    const authHeader = ctx.request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        ctx.response.status = 401;
        ctx.response.body = { error: 'Authorization token required' };
        return;
    }

    const token = authHeader.substring(7);
    const payload = await authService.verifyToken(token);

    if (!payload) {
        ctx.response.status = 401;
        ctx.response.body = { error: 'Invalid or expired token' };
        return;
    }

    ctx.state.user = payload;
    await next();
};

const requireRole = (role: string) => async (ctx: any, next: any) => {
    if (ctx.state.user.role !== role && ctx.state.user.role !== 'admin') {
        ctx.response.status = 403;
        ctx.response.body = { error: 'Insufficient permissions' };
        return;
    }
    await next();
};

// CORS middleware
app.use(async (ctx, next) => {
    ctx.response.headers.set('Access-Control-Allow-Origin', '*');
    ctx.response.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    ctx.response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (ctx.request.method === 'OPTIONS') {
        ctx.response.status = 200;
        return;
    }

    await next();
});

app.use(authMiddleware);

// Auth Routes
router
    .post("/api/auth/login", async (ctx) => {
        try {
            const body = await ctx.request.body().value;
            const { username, password } = body;

            if (!username || !password) {
                ctx.response.status = 400;
                ctx.response.body = { error: "Username and password required" };
                return;
            }

            console.log(`🔐 Login attempt for user: ${username}`);

            const token = await authService.authenticate(username, password);

            if (!token) {
                ctx.response.status = 401;
                ctx.response.body = { error: "Invalid credentials" };
                return;
            }

            ctx.response.body = {
                message: "Login successful",
                token,
                user: {
                    username,
                    role: authService.getUser(username)?.role
                }
            };
        } catch (error) {
            console.error("Login error:", error);
            ctx.response.body = { error: "Login failed" };
            ctx.response.status = 500;
        }
    })
    .post("/api/auth/register", requireRole('admin'), async (ctx) => {
        try {
            const body = await ctx.request.body().value;
            const { username, password, role = "user" } = body;

            if (!username || !password) {
                ctx.response.status = 400;
                ctx.response.body = { error: "Username and password required" };
                return;
            }

            const success = await authService.createUser(username, password, role);

            if (!success) {
                ctx.response.status = 409;
                ctx.response.body = { error: "User already exists" };
                return;
            }

            ctx.response.body = { message: "User created successfully" };
        } catch (error) {
            console.error("Registration error:", error);
            ctx.response.body = { error: "Registration failed" };
            ctx.response.status = 500;
        }
    })
    .get("/api/auth/me", async (ctx) => {
        ctx.response.body = {
            user: ctx.state.user
        };
    })
    .get("/api/auth/users", requireRole('admin'), async (ctx) => {
        const users = authService.listUsers().map(user => ({
            username: user.username,
            role: user.role,
            createdAt: user.createdAt
        }));
        ctx.response.body = users;
    });

router.get("/preview/:deploymentId/:path*", async (ctx) => {
    const deploymentId = ctx.params.deploymentId;
    const path = ctx.params.path || "index.html";

    const deployment = deploymentService.getDeployment(deploymentId);
    if (!deployment) {
        ctx.response.status = 404;
        ctx.response.body = "Deployment not found";
        return;
    }

    if (deployment.expiresAt <= new Date()) {
        ctx.response.status = 410;
        ctx.response.body = "This preview has expired and been deleted";
        return;
    }

    const filePath = join("./deployments", deploymentId, path);

    try {
        const file = await Deno.readFile(filePath);

        const ext = path.split('.').pop()?.toLowerCase();
        const contentTypes: Record<string, string> = {
            'html': 'text/html; charset=utf-8',
            'css': 'text/css; charset=utf-8',
            'js': 'application/javascript; charset=utf-8',
            'json': 'application/json; charset=utf-8',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'svg': 'image/svg+xml',
            'ico': 'image/x-icon',
            'woff': 'font/woff',
            'woff2': 'font/woff2',
            'ttf': 'font/ttf',
            'map': 'application/json'
        };

        ctx.response.headers.set('Content-Type', contentTypes[ext] || 'text/plain; charset=utf-8');

        if (['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'woff', 'woff2', 'ttf'].includes(ext || '')) {
            ctx.response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        ctx.response.body = file;
    } catch (error) {
        if (path !== "index.html") {
            try {
                const indexFile = await Deno.readFile(join("./deployments", deploymentId, "index.html"));
                ctx.response.headers.set('Content-Type', 'text/html; charset=utf-8');
                ctx.response.body = indexFile;
                return;
            } catch {
                ctx.response.status = 404;
                ctx.response.body = "File not found";
                return;
            }
        }
        ctx.response.status = 404;
        ctx.response.body = "File not found";
    }
});

// Protected API Routes
router
    .post("/api/deployments", async (ctx) => {
        try {
            const body = await ctx.request.body().value;
            const { projectId, branch, commit, files } = body;

            if (!projectId || !files) {
                ctx.response.status = 400;
                ctx.response.body = { error: "Missing required fields: projectId and files are required" };
                return;
            }

            console.log(`📦 Creating deployment for project: ${projectId} by user: ${ctx.state.user.username}`);

            const deployment = await deploymentService.createDeployment(
                projectId,
                branch || "main",
                commit || "latest",
                files,
                ctx.state.user.username
            );

            ctx.response.body = deployment;
            ctx.response.status = 201;
        } catch (error) {
            console.error("Deployment error:", error);
            ctx.response.body = { error: `Deployment failed: ${error}` };
            ctx.response.status = 500;
        }
    })
    .delete("/api/deployments/:id", async (ctx) => {
        try {
            const deploymentId = ctx.params.id;

            if (!deploymentId) {
                ctx.response.status = 400;
                ctx.response.body = { error: "Deployment ID is required" };
                return;
            }

            console.log(`🗑️ Deleting deployment: ${deploymentId} by user: ${ctx.state.user.username}`);

            const success = await deploymentService.deleteDeployment(deploymentId);

            if (!success) {
                ctx.response.status = 404;
                ctx.response.body = { error: "Deployment not found" };
                return;
            }

            ctx.response.body = {
                message: "Deployment deleted successfully",
                id: deploymentId
            };
            ctx.response.status = 200;

        } catch (error) {
            console.error("Delete deployment error:", error);
            ctx.response.body = { error: `Delete failed: ${error}` };
            ctx.response.status = 500;
        }
    })
    .post("/api/cleanup", requireRole('admin'), async (ctx) => {
        try {
            console.log(`🧹 Manual cleanup triggered by user: ${ctx.state.user.username}`);
            const result = await deploymentService.forceCleanup();

            ctx.response.body = {
                message: "Cleanup completed",
                ...result
            };
            ctx.response.status = 200;
        } catch (error) {
            console.error("Cleanup error:", error);
            ctx.response.body = { error: `Cleanup failed: ${error}` };
            ctx.response.status = 500;
        }
    })
    .get("/api/deployments", async (ctx) => {
        const deployments = deploymentService.getAllDeployments();

        const deploymentsWithExpiry = deployments.map(deployment => ({
            ...deployment,
            expiresIn: Math.max(0, deployment.expiresAt.getTime() - Date.now()),
            isExpired: deployment.expiresAt <= new Date()
        }));

        ctx.response.body = deploymentsWithExpiry;
    })
    .get("/api/deployments/:projectId", async (ctx) => {
        const deployments = deploymentService.getProjectDeployments(ctx.params.projectId);

        const deploymentsWithExpiry = deployments.map(deployment => ({
            ...deployment,
            expiresIn: Math.max(0, deployment.expiresAt.getTime() - Date.now()),
            isExpired: deployment.expiresAt <= new Date()
        }));

        ctx.response.body = deploymentsWithExpiry;
    })
    .get("/api/deployment/:id", async (ctx) => {
        const deployment = deploymentService.getDeployment(ctx.params.id);
        if (!deployment) {
            ctx.response.status = 404;
            ctx.response.body = { error: "Deployment not found" };
            return;
        }

        const deploymentWithExpiry = {
            ...deployment,
            expiresIn: Math.max(0, deployment.expiresAt.getTime() - Date.now()),
            isExpired: deployment.expiresAt <= new Date(),
            daysLeft: Math.ceil((deployment.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        };

        ctx.response.body = deploymentWithExpiry;
    });


// Health check endpoint
router.get("/health", (ctx) => {
    ctx.response.body = {
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "deno-hosting"
    };
});

router.get("/api/health", (ctx) => {
    ctx.response.body = {
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "deno-hosting-api"
    };
});

// Root endpoint
router.get("/", (ctx) => {
    ctx.response.body = {
        message: "Hosting API",
        version: "1.0.0",
        endpoints: {
            health: "/health",
            api: "/api/",
            deployments: "/api/deployments",
            auth: "/api/auth/login"
        }
    };
});


app.use(router.routes());
app.use(router.allowedMethods());

const port = 8000;
console.log(`🚀 Hosting Server running on port ${port}`);
console.log(`📁 Deployments directory: ${Deno.cwd()}/deployments`);
console.log(`⏰ Auto-cleanup: Enabled (every 6 hours)`);
console.log(`🔐 Authentication: Enabled`);
console.log(`💻 Platform: ${Deno.build.os}`);

const gracefulShutdown = () => {
    console.log('🛑 Shutting down gracefully...');
    deploymentService.stopCleanupJob();
    Deno.exit(0);
};

if (Deno.build.os === "windows") {
    console.log('💡 Press Ctrl+C to stop the server');
    Deno.addSignalListener('SIGINT', gracefulShutdown);
} else {
    console.log('💡 Press Ctrl+C to stop the server');
    Deno.addSignalListener('SIGINT', gracefulShutdown);
    Deno.addSignalListener('SIGTERM', gracefulShutdown);
}

try {
    await app.listen({ port });
} catch (error) {
    console.error('Server error:', error);
} finally {
    deploymentService.stopCleanupJob();
}