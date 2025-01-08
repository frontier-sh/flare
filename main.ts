import { Plugin, Notice, Setting, PluginSettingTab, App } from "obsidian";
import simpleGit, { SimpleGit } from "simple-git";

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

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "publish-post",
			name: "Publish Post",
			callback: () => this.publishPost(),
		});

		this.addSettingTab(new FlareSettingTab(this.app, this));

		if (this.settings.githubToken) {
			await this.initGit();
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

	async initGit() {
		const basePath = (this.app.vault.adapter as any).getBasePath();
		this.git = simpleGit({
			baseDir: basePath,
		});

		try {
			// Check if git is initialized
			await this.git.revparse(["--git-dir"]);
		} catch {
			// If not, initialize git and set up the remote
			await this.git.init();
			await this.git.addRemote(
				"origin",
				`https://github.com/${this.settings.repositoryOwner}/${this.settings.repositoryName}.git`
			);

			// Set up initial commit if needed
			try {
				await this.git.add(".gitignore");
				await this.git.commit("Initial commit");
			} catch {
				// If commit fails, it's okay - might mean there's no .gitignore
			}

			// Configure git user
			await this.git.addConfig("user.name", "Flare");
			await this.git.addConfig("user.email", "flare@frontier.sh");
		}
	}

	async publishPost() {
		if (!this.settings.githubToken) {
			new Notice("Please connect to GitHub first in the Flare settings");
			return;
		}

		try {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("No active file to publish");
				return;
			}

			// Ensure we're on main branch and have latest changes
			try {
				await this.git.fetch("origin");
				await this.git.checkout("main");
				await this.git.pull("origin", "main");
			} catch (e) {
				// If main branch doesn't exist yet, create it
				await this.git.checkout(["-b", "main"]);
			}

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const branchName = `post-${timestamp}`;

			// Create and checkout new branch
			await this.git.checkoutLocalBranch(branchName);

			// Stage and commit changes
			await this.git.add(activeFile.path);
			const commitMessage = `Add blog post: ${activeFile.basename}`;
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
						base: "main",
						body: "Created via Flare",
						auto_merge: true,
					}),
				}
			);

			if (!prResponse.ok) {
				throw new Error(
					`Failed to create PR: ${await prResponse.text()}`
				);
			}

			new Notice("Successfully created PR with auto-merge enabled");
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

						// Open web app directly for auth and repo selection
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
