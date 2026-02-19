const axios = require('axios');
const chalk = require('chalk');
const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');
const { ConfigManager } = require('./utils');

class AuthManager {
    constructor() {
        this.config = new ConfigManager();
    }

    async login(apiUrl, options) {
        let { username, password, token } = options;

        if (token) {
            await this.config.set('token', token);
            await this.config.set('apiUrl', apiUrl);
            return token;
        }

        // Если credentials не предоставлены, запросим их
        if (!username || !password) {
            const answers = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'username',
                    message: 'Username:',
                    when: !username
                },
                {
                    type: 'password',
                    name: 'password',
                    message: 'Password:',
                    when: !password
                }
            ]);

            username = username || answers.username;
            password = password || answers.password;
        }

        if (!username || !password) {
            throw new Error('Username and password are required');
        }

        try {
            const response = await axios.post(`${apiUrl}/api/auth/login`, {
                username,
                password
            });

            const { token, user } = response.data;

            // Сохраняем токен и настройки
            await this.config.set('token', token);
            await this.config.set('apiUrl', apiUrl);
            await this.config.set('user', user);

            console.log(chalk.green(`✅ Logged in as ${user.username} (${user.role})`));
            return token;
        } catch (error) {
            if (error.response?.status === 401) {
                throw new Error('Invalid credentials');
            }
            throw new Error(`Login failed: ${error}`);
        }
    }

    async getAuthHeaders() {
        const token = await this.config.get('token');
        if (!token) {
            throw new Error('Not authenticated. Please run "mudhost login" first.');
        }

        return {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
    }

    async whoami(apiUrl) {
        try {
            const headers = await this.getAuthHeaders();
            const response = await axios.get(`${apiUrl}/api/auth/me`, { headers });

            const user = response.data.user;
            const config = await this.config.getAll();

            console.log(chalk.blue('👤 Current User:'));
            console.log(`  Username: ${chalk.bold(user.username)}`);
            console.log(`  Role: ${chalk.bold(user.role)}`);
            console.log(`  API: ${chalk.bold(config.apiUrl)}`);
        } catch (error) {
            throw new Error(`Failed to get user info: ${error}`);
        }
    }

    logout() {
        this.config.clear();
    }
}

module.exports = { AuthManager };