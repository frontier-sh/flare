import {
	Plugin,
	Notice,
	Setting,
	PluginSettingTab,
	App,
	TFile,
} from "obsidian";
import simpleGit, { SimpleGit } from "simple-git";
import * as path from "path";
import * as fs from "fs";

const WORKER_URL = "https://flare.frontier.sh";
const GITHUB_CLIENT_ID = "Ov23liZYcWsgjBgJz5T5";

interface FlareSettings {
	githubToken: string;
	repositoryOwner: string;
	repositoryName: string;
	state?: string;
}

const DEFAULT_SETTINGS: FlareSettings = {
	githubToken: "",
	repositoryOwner: "",
	repositoryName: "",
};

export default class FlarePlugin extends Plugin {
	settings: FlareSettings;
	private git: SimpleGit;
	private gitDir: string;

	async onload() {
		await this.loadSettings();

		this.gitDir = path.join(
			(this.app.vault.adapter as any).getBasePath(),
			".obsidian",
			"flare-git"
		);

		this.addCommand({
			id: "publish-post",
			name: "Publish Post",
			callback: () => this.publishPost(),
		});

		this.addSettingTab(new FlareSettingTab(this.app, this));

		// Only initialize git if the directory exists and we have a token
		if (this.settings.githubToken && fs.existsSync(this.gitDir)) {
			this.git = simpleGit({
				baseDir: this.gitDir,
			});
		}
	}

	async resetGitDirectory() {
		if (fs.existsSync(this.gitDir)) {
			fs.rmSync(this.gitDir, { recursive: true, force: true });
		}
		fs.mkdirSync(this.gitDir, { recursive: true });
	}

	async initGit() {
		if (!fs.existsSync(this.gitDir)) {
			fs.mkdirSync(this.gitDir, { recursive: true });
		}

		this.git = simpleGit({
			baseDir: this.gitDir,
		});

		// Initialize fresh repo
		await this.git.init();
		await this.git.addRemote(
			"origin",
			`https://github.com/${this.settings.repositoryOwner}/${this.settings.repositoryName}.git`
		);

		await this.git.addConfig("user.name", "Flare by Frontier.sh");
		await this.git.addConfig("user.email", "flare@frontier.sh");

		try {
			await this.git.fetch("origin");
			await this.git.checkout("main");
		} catch (e) {
			await this.git.checkout(["-b", "main"]);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async getChangedMarkdownFiles(): Promise<TFile[]> {
		const vault = this.app.vault;
		const files = vault.getMarkdownFiles();
		const changedFiles: TFile[] = [];

		for (const file of files) {
			const vaultPath = file.path;
			const gitPath = path.join(this.gitDir, vaultPath);

			// If file doesn't exist in git, it's new
			if (!fs.existsSync(gitPath)) {
				changedFiles.push(file);
				continue;
			}

			// Compare file content
			const vaultContent = await vault.read(file);
			const gitContent = fs.readFileSync(gitPath, "utf8");

			if (vaultContent !== gitContent) {
				changedFiles.push(file);
			}
		}

		return changedFiles;
	}

	async publishPost() {
		if (!this.settings.githubToken) {
			new Notice("Please connect to GitHub first in the Flare settings");
			return;
		}

		try {
			const changedFiles = await this.getChangedMarkdownFiles();

			if (changedFiles.length === 0) {
				new Notice("No changes to publish");
				return;
			}

			// First, fetch to make sure we have latest remote info
			await this.git.fetch("origin");

			// Get the default branch from GitHub API
			const repoResponse = await fetch(
				`https://api.github.com/repos/${this.settings.repositoryOwner}/${this.settings.repositoryName}`,
				{
					headers: {
						Authorization: `Bearer ${this.settings.githubToken}`,
						Accept: "application/vnd.github.v3+json",
					},
				}
			);

			if (!repoResponse.ok) {
				throw new Error("Failed to get repository information");
			}

			const repoInfo = await repoResponse.json();
			const defaultBranch = repoInfo.default_branch;

			// Check if the repository is empty by trying to get the default branch
			const branchResponse = await fetch(
				`https://api.github.com/repos/${this.settings.repositoryOwner}/${this.settings.repositoryName}/branches/${defaultBranch}`,
				{
					headers: {
						Authorization: `Bearer ${this.settings.githubToken}`,
						Accept: "application/vnd.github.v3+json",
					},
				}
			);

			const isEmpty = !branchResponse.ok; // If we can't get the branch, repo is empty

			if (isEmpty) {
				try {
					// Try to switch to the default branch if it exists
					await this.git.checkout(defaultBranch);
				} catch {
					// If it doesn't exist, create it
					await this.git.checkout(["-b", defaultBranch]);
				}

				// Copy and add all changed files
				for (const file of changedFiles) {
					const fileContent = await this.app.vault.read(file);
					const targetPath = path.join(this.gitDir, file.path);
					const targetDir = path.dirname(targetPath);

					if (!fs.existsSync(targetDir)) {
						fs.mkdirSync(targetDir, { recursive: true });
					}

					fs.writeFileSync(targetPath, fileContent);
					await this.git.add(file.path);
				}

				await this.git.commit("Initial commit");
				await this.git.push("origin", defaultBranch);

				new Notice(`Created first commit on ${defaultBranch}`);
				return;
			}

			// For non-empty repos, continue with normal PR flow
			try {
				await this.git.checkout(defaultBranch);
				await this.git.pull("origin", defaultBranch);
			} catch (e) {
				// If checkout fails, force create tracking branch
				try {
					await this.git.checkout([
						"-B",
						defaultBranch,
						`origin/${defaultBranch}`,
					]);
				} catch {
					// If that fails too, just create the branch
					await this.git.checkout(["-B", defaultBranch]);
				}
			}

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const branchName = `post-${timestamp}`;

			// Create new branch
			await this.git.checkout(["-b", branchName]);

			// Copy all changed files to git directory
			for (const file of changedFiles) {
				const fileContent = await this.app.vault.read(file);
				const targetPath = path.join(this.gitDir, file.path);
				const targetDir = path.dirname(targetPath);

				if (!fs.existsSync(targetDir)) {
					fs.mkdirSync(targetDir, { recursive: true });
				}

				fs.writeFileSync(targetPath, fileContent);
				await this.git.add(file.path);
			}

			// Create commit with all changes
			const fileNames = changedFiles.map((f) => f.basename).join(", ");
			const commitMessage =
				changedFiles.length === 1
					? `Update post: ${fileNames}`
					: `Update posts: ${fileNames}`;

			await this.git.commit(commitMessage);
			await this.git.push("origin", branchName);

			// Create PR using GitHub API
			const prResponse = await fetch(
				`https://api.github.com/repos/${this.settings.repositoryOwner}/${this.settings.repositoryName}/pulls`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.settings.githubToken}`,
						Accept: "application/vnd.github.v3+json",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						title: commitMessage,
						head: branchName,
						base: defaultBranch,
						body: `Updated ${changedFiles.length} file(s) via Flare`,
						auto_merge: true,
					}),
				}
			);

			if (!prResponse.ok) {
				const errorData = await prResponse.json();
				throw new Error(
					`Failed to create PR: ${JSON.stringify(errorData)}`
				);
			}

			new Notice(
				`Successfully created PR with ${changedFiles.length} file(s)`
			);
		} catch (error) {
			new Notice(`Failed to publish: ${error.message}`);
			console.error("Publishing error:", error);
		}
	}
}

class FlareSettingTab extends PluginSettingTab {
	plugin: FlarePlugin;

	constructor(app: App, plugin: FlarePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		if (!this.plugin.settings.githubToken) {
			new Setting(containerEl)
				.setName("Connect to GitHub")
				.setDesc("Authenticate with GitHub and select your repository")
				.addButton((button) =>
					button.setButtonText("Connect").onClick(() => {
						const state = crypto.randomUUID();
						this.plugin.settings.state = state;
						this.plugin.saveSettings();
						window.open(
							`${WORKER_URL}/?client=obsidian&state=${state}`,
							"_blank"
						);
						this.pollForSetup(state);
					})
				);
		} else {
			new Setting(containerEl)
				.setName("GitHub Status")
				.setDesc(
					`Connected to ${this.plugin.settings.repositoryOwner}/${this.plugin.settings.repositoryName}`
				)
				.addButton((button) =>
					button.setButtonText("Disconnect").onClick(async () => {
						// Reset everything on disconnect
						await this.plugin.resetGitDirectory();
						this.plugin.settings.githubToken = "";
						this.plugin.settings.repositoryOwner = "";
						this.plugin.settings.repositoryName = "";
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}
	}

	async pollForSetup(state: string) {
		const checkSetup = async () => {
			try {
				const response = await fetch(
					`${WORKER_URL}/api/check-setup?state=${state}`
				);
				if (response.ok) {
					const data = await response.json();

					// Only reset if we're connecting to a different repo
					if (
						this.plugin.settings.repositoryOwner !== data.owner ||
						this.plugin.settings.repositoryName !== data.repo
					) {
						await this.plugin.resetGitDirectory();
					}

					this.plugin.settings.githubToken = data.access_token;
					this.plugin.settings.repositoryOwner = data.owner;
					this.plugin.settings.repositoryName = data.repo;
					await this.plugin.saveSettings();

					try {
						await this.plugin.initGit();
						this.display();
						new Notice("Successfully connected to GitHub!");
					} catch (error) {
						new Notice(
							"Failed to initialize git repository: " +
								error.message
						);
						console.error("Git init error:", error);
					}
					return;
				}
				setTimeout(checkSetup, 2000);
			} catch (error) {
				console.error("Setup check failed:", error);
				setTimeout(checkSetup, 2000);
			}
		};

		checkSetup();
	}
}
