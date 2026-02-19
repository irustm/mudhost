const { Command } = require('commander');
const chalk = require('chalk');
const { AuthManager } = require('./auth');
const { DeployManager } = require('./deploy');
const { ConfigManager } = require('./utils');

class CLI {
    constructor() {
        this.program = new Command();
        this.auth = new AuthManager();
        this.deploy = new DeployManager();
        this.config = new ConfigManager();
        this.setupCommands();
    }

    setupCommands() {
        this.program
            .name('mudhost')
            .description('CLI for Mud Hosting - Deploy preview environments')
            .version('1.0.0');

        // Login command
        this.program
            .command('login')
            .description('Login to Mud Hosting')
            .option('-u, --username <username>', 'Username')
            .option('-p, --password <password>', 'Password')
            .option('-t, --token <token>', 'Token (overrides username and password)')
            .option('--api <url>', 'API URL', 'http://localhost:8000')
            .action(async (options) => {
                await this.handleLogin(options);
            });

        // Deploy command
        this.program
            .command('deploy')
            .description('Deploy a project')
            .argument('<project-id>', 'Project ID')
            .argument('[dist-dir]', 'Distribution directory', './dist')
            .option('-b, --branch <branch>', 'Git branch', 'main')
            .option('-c, --commit <commit>', 'Git commit', 'latest')
            .option('--api <url>', 'API URL')
            .option('--config <file>', 'Config file')
            .action(async (projectId, distDir, options) => {
                await this.handleDeploy(projectId, distDir, options);
            });

        // List command
        this.program
            .command('list')
            .description('List deployments')
            .option('--api <url>', 'API URL')
            .option('-p, --project <projectId>', 'Filter by project')
            .action(async (options) => {
                await this.handleList(options);
            });

        // Delete command
        this.program
            .command('delete')
            .description('Delete a deployment')
            .argument('<deployment-id>', 'Deployment ID')
            .option('--api <url>', 'API URL')
            .action(async (deploymentId, options) => {
                await this.handleDelete(deploymentId, options);
            });

        // Whoami command
        this.program
            .command('whoami')
            .description('Show current user info')
            .option('--api <url>', 'API URL')
            .action(async (options) => {
                await this.handleWhoami(options);
            });

        // Logout command
        this.program
            .command('logout')
            .description('Logout and clear saved token')
            .action(() => {
                this.handleLogout();
            });

        // Init command
        this.program
            .command('init')
            .description('Create config file')
            .action(() => {
                this.handleInit();
            });
    }

    async handleLogin(options) {
        const apiUrl = options.api || await this.config.get('apiUrl') || 'http://localhost:8000';

        try {
            await this.auth.login(apiUrl, options);
            console.log(chalk.green('✅ Login successful!'));
        } catch (error) {
            console.error(chalk.red('❌ Login failed:'), error);
            process.exit(1);
        }
    }

    async handleDeploy(projectId, distDir, options) {
        const apiUrl = options.api || await this.config.get('apiUrl');

        if (!apiUrl) {
            console.error(chalk.red('❌ API URL not configured. Please login first or use --api option.'));
            process.exit(1);
        }

        try {
            await this.deploy.deploy(projectId, distDir, options, apiUrl);
        } catch (error) {
            console.error(chalk.red('❌ Deployment failed:'), error);
            process.exit(1);
        }
    }

    async handleList(options) {
        const apiUrl = options.api || await this.config.get('apiUrl');

        if (!apiUrl) {
            console.error(chalk.red('❌ API URL not configured. Please login first or use --api option.'));
            process.exit(1);
        }

        try {
            await this.deploy.listDeployments(apiUrl, options.project);
        } catch (error) {
            console.error(chalk.red('❌ Failed to list deployments:'), error);
            process.exit(1);
        }
    }

    async handleDelete(deploymentId, options) {
        const apiUrl = options.api || await this.config.get('apiUrl');

        if (!apiUrl) {
            console.error(chalk.red('❌ API URL not configured. Please login first or use --api option.'));
            process.exit(1);
        }

        try {
            await this.deploy.deleteDeployment(deploymentId, apiUrl);
        } catch (error) {
            console.error(chalk.red('❌ Failed to delete deployment:'), error);
            process.exit(1);
        }
    }

    async handleWhoami(options) {
        const apiUrl = options.api || await this.config.get('apiUrl');

        if (!apiUrl) {
            console.error(chalk.red('❌ API URL not configured. Please login first or use --api option.'));
            process.exit(1);
        }

        try {
            await this.auth.whoami(apiUrl);
        } catch (error) {
            console.error(chalk.red('❌ Failed to get user info:'), error);
            process.exit(1);
        }
    }

    handleLogout() {
        this.auth.logout();
        console.log(chalk.green('✅ Logged out successfully!'));
    }

    handleInit() {
        this.config.createConfig();
    }

    async run() {
        await this.program.parseAsync(process.argv);
    }
}

module.exports = { CLI };