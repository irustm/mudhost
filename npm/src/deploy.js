const axios = require('axios');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const glob = require('glob');
const mime = require('mime-types');
const ora = require('ora');
const { AuthManager } = require('./auth');

class DeployManager {
    constructor() {
        this.auth = new AuthManager();
    }

    isValidUtf8(content) {
        const decoded = content.toString('utf8');
        return Buffer.from(decoded, 'utf8').equals(content);
    }

    isBinaryFile(filePath, content) {
        const binaryExtensions = new Set([
            'wasm', 'woff', 'woff2', 'ttf', 'otf', 'eot',
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico',
            'pdf', 'zip', 'gz', 'br'
        ]);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        if (binaryExtensions.has(ext)) {
            return true;
        }
        return !this.isValidUtf8(content);
    }

    async collectFiles(distDir) {
        const spinner = ora('📁 Scanning files...').start();

        if (!await fs.pathExists(distDir)) {
            spinner.fail();
            throw new Error(`Directory not found: ${distDir}`);
        }

        try {
            const files = {};
            const allFiles = glob.sync('**/*', {
                cwd: distDir,
                nodir: true,
                dot: true
            });

            for (const filePath of allFiles) {
                const fullPath = path.join(distDir, filePath);
                const content = await fs.readFile(fullPath);
                if (this.isBinaryFile(filePath, content)) {
                    files[filePath] = {
                        content: content.toString('base64'),
                        encoding: 'base64'
                    };
                } else {
                    files[filePath] = {
                        content: content.toString('utf8'),
                        encoding: 'utf8'
                    };
                }
            }

            spinner.succeed(`Found ${allFiles.length} files`);
            return files;
        } catch (error) {
            spinner.fail();
            throw new Error(`Failed to read files: ${error}`);
        }
    }

    async deploy(projectId, distDir, options, apiUrl) {
        const spinner = ora('🚀 Deploying...').start();

        try {
            // Собираем файлы
            const files = await this.collectFiles(distDir);

            if (Object.keys(files).length === 0) {
                spinner.fail();
                throw new Error(`No files found in ${distDir}`);
            }

            // Получаем заголовки аутентификации
            const headers = await this.auth.getAuthHeaders();

            // Отправляем деплой
            spinner.text = '📦 Uploading deployment...';

            const response = await axios.post(`${apiUrl}/api/deployments`, {
                projectId,
                branch: options.branch,
                commit: options.commit,
                files
            }, { headers });

            const deployment = response.data;

            spinner.succeed('✅ Deployment successful!');

            console.log(chalk.green('\n📊 Deployment Info:'));
            console.log(`  Project: ${chalk.bold(deployment.projectId)}`);
            console.log(`  Branch: ${chalk.bold(deployment.branch)}`);
            console.log(`  ID: ${chalk.bold(deployment.id)}`);
            console.log(`  Files: ${chalk.bold(deployment.files.length)}`);

            console.log(chalk.blue('\n🌐 Preview URLs:'));
            deployment.urls?.forEach(url => {
                console.log(`  ${chalk.cyan('→')} ${chalk.underline(url)}`);
            });

            if (deployment.url) {
                console.log(`  ${chalk.cyan('→')} ${chalk.underline(deployment.url)}`);
            }

            return deployment;
        } catch (error) {
            spinner.fail();

            if (error.response) {
                const status = error.response.status;
                const message = error.response.data?.error || error;

                switch (status) {
                    case 401:
                        throw new Error('Authentication failed. Please login again.');
                    case 413:
                        throw new Error('Deployment too large. Reduce file size.');
                    default:
                        throw new Error(`HTTP ${status}: ${message}`);
                }
            }

            throw new Error(`Deployment failed: ${error}`);
        }
    }

    async listDeployments(apiUrl, projectFilter) {
        const spinner = ora('📋 Loading deployments...').start();

        try {
            const headers = await this.auth.getAuthHeaders();
            const response = await axios.get(`${apiUrl}/api/deployments`, { headers });

            let deployments = response.data;

            // Фильтруем по проекту если нужно
            if (projectFilter) {
                deployments = deployments.filter(d => d.projectId === projectFilter);
            }

            spinner.succeed(`Found ${deployments.length} deployments`);

            if (deployments.length === 0) {
                console.log(chalk.yellow('No deployments found'));
                return;
            }

            console.log('\n' + chalk.blue.bold('📦 Deployments:'));
            console.log('=' .repeat(80));

            deployments.forEach(deployment => {
                const status = deployment.isExpired ? chalk.red('❌ EXPIRED') : chalk.green('✅ ACTIVE');
                const daysLeft = deployment.isExpired ?
                    'EXPIRED' :
                    `${Math.ceil(deployment.expiresIn / (1000 * 60 * 60 * 24))} days`;

                console.log(`🆔 ${chalk.bold(deployment.id)}`);
                console.log(`   📁 ${chalk.gray('Project:')} ${deployment.projectId}`);
                console.log(`   🌿 ${chalk.gray('Branch:')} ${deployment.branch}`);
                console.log(`   🔗 ${chalk.gray('URL:')} ${chalk.cyan(deployment.url)}`);
                console.log(`   📅 ${chalk.gray('Created:')} ${new Date(deployment.createdAt).toLocaleString()}`);
                console.log(`   ⏰ ${chalk.gray('Status:')} ${status} (${daysLeft} left)`);
                console.log(`   📊 ${chalk.gray('Files:')} ${deployment.files.length}`);
                console.log('-'.repeat(80));
            });

        } catch (error) {
            spinner.fail();
            throw new Error(`Failed to list deployments: ${error}`);
        }
    }

    async deleteDeployment(deploymentId, apiUrl) {
        const spinner = ora('🗑️ Deleting deployment...').start();

        try {
            const headers = await this.auth.getAuthHeaders();
            await axios.delete(`${apiUrl}/api/deployments/${deploymentId}`, { headers });

            spinner.succeed(`✅ Deployment ${deploymentId} deleted successfully`);
        } catch (error) {
            spinner.fail();

            if (error.response?.status === 404) {
                throw new Error(`Deployment not found: ${deploymentId}`);
            }

            throw new Error(`Failed to delete deployment: ${error}`);
        }
    }
}

module.exports = { DeployManager };