#!/usr/bin/env node

import { prompt, ui, registerPrompt } from "inquirer";
import { Octokit } from "@octokit/rest";
import { dirname, join, normalize, basename, extname, relative } from "path";
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, unlink, unlinkSync, statSync, writeFileSync } from "fs";
import { Extract } from "unzipper";
import { mv, rm } from "shelljs";
import { sync as globSync } from "glob";
import { CustomComponent, TrackVersionByBranch, TrackVersionByReleases, TrackVersionType, Storage } from "../Storage";
import { Crawler } from "../Crawler";
import { option, parse } from "args";

registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));

option("fetch", "Refetch all added custom components and download newest version (regarding configured semver)", false);
const args = parse(process.argv);

const storage = new Storage();
let octokit = new Octokit();
wait();

async function executeWithProgressBar<K>(logMessage: string, promise: Promise<K>, doneMsg: string = logMessage): Promise<K> {
	return new Promise(async (resolve) => {
		var clock = [
			`/ ${logMessage}`, `| ${logMessage}`, `\\ ${logMessage}`, `- ${logMessage}`,
			`/ ${logMessage}`, `| ${logMessage}`, `\\ ${logMessage}`, `- ${logMessage}`
		];
		var i = 0;
		var bar = new ui.BottomBar();

		var tickInterval = setInterval(() => {
			bar.updateBottomBar(clock[i++ % clock.length]);
		}, 250);

		const result = await promise;
		clearInterval(tickInterval);
		bar.updateBottomBar(`✓ ${doneMsg}\n`);
		resolve(result);
	});
}

async function checkHasHACSFile(url: string): Promise<boolean> {
	const parsedUrl = Crawler.ParseURL(url);
	const response = await octokit.repos.getContent({
		owner: parsedUrl.owner,
		repo: parsedUrl.repo,
		path: "",
	});

	const files = response.data as any;
	return files.some((f: any) => f.name === "hacs.json");
}

async function getHACSFile(url: string): Promise<{ [index: string]: any } | null> {
	const hasHACSFile = await executeWithProgressBar("Checking the repository...", checkHasHACSFile(url));
	if (hasHACSFile) {
		const parsedUrl = Crawler.ParseURL(url);
		const response = await octokit.repos.getContent({
			owner: parsedUrl.owner,
			repo: parsedUrl.repo,
			path: "hacs.json",
			mediaType: {
				format: "raw"
			}
		});

		if (typeof response.data === "string") {
			return JSON.parse(response.data);
		} else {
			throw new Error("Unexpected response");
		}
	}

	return null;
}

/**
 * This function tries to determine the base dir where the needed files of the custom component are stored.
 * @param localPath Path to the local downloaded release
 */
async function getContentBaseDir(url: string, localPath: string, hacsJSON?: { [index: string]: any } | null) {
	let baseDir: string | null = null;
	if (hacsJSON && hacsJSON.filename) {
		const result = globSync(join(localPath, `**/${hacsJSON.filename}`));
		if (result && result.length > 0) {
			baseDir = relative(localPath, dirname(result[0]));
		}
	}

	if (baseDir === null) {
		const releaseContent = readdirSync(localPath);
		const parsedPath = Crawler.ParseURL(url);
		let ok = (await prompt([{
			name: "ok",
			type: "confirm",
			message: `The release contains the following files:\n  ${releaseContent.join("\n  ")}\nThis is exactly the content which will be placed in your 'custom_components/${parsedPath.repo}'. Does this looks good to you?`,
			default: true,
		}])).ok;

		if (!ok) {
			baseDir = await selectBaseDirManually(localPath);
		}
	}

	if (baseDir === ".") {
		baseDir = "";
	}

	return baseDir || "";
}

async function selectBaseDirManually(localPath: string): Promise<string> {
	let ok = false;
	let baseDir = "";
	do {
		const files = readdirSync(join(localPath, baseDir))
			.filter(f => statSync(join(localPath, baseDir, f)).isDirectory());
		const result = await prompt([{
			name: "path",
			type: "autocomplete",
			message: "Select a path or select <done> if you are fine",
			source: (answersSoFar: any, input: string) => {
				const filtered = files.filter(f => input ? f.match(input) : true);
				if (baseDir) {
					return [...filtered, "..", "<done>"];
				} else {
					return [...filtered, "<done>"];
				}
			}
		}]);

		if (result.path === "..") {
			baseDir = normalize(join(baseDir, ".."));
		} else if (result.path === "<done>") {
			ok = true;
		} else {
			baseDir = join(baseDir, result.path);
		}
	} while (!ok);

	return baseDir;
}

/**
 * Downloads the latest release of the repository
 * @param url
 */
async function downloadLatestRelease(url: string, hacsJSON?: { [index: string]: any } | null) {
	const latestRelease = await executeWithProgressBar("Request latest release...", Crawler.GetLatestRelease(url));
	let assetDownloadUrl = "";
	let assetFileName = "";

	if (latestRelease.assets.length > 0) {
		assetFileName = (await prompt([{
			name: "targetAsset",
			type: "list",
			message: "Please select the asset which should be downloaded:",
			choices: latestRelease.assets.map(a => a.name),
			default: hacsJSON ? hacsJSON.filename : undefined
		}])).targetAsset;

		const targetAsset = latestRelease.assets.filter(a => a.name === assetFileName)[0];
		assetDownloadUrl = targetAsset.browser_download_url;
	} else {
		assetDownloadUrl = `${url}/archive/refs/tags/${latestRelease.tag_name}.zip`;
	}

	let localPath = join(process.cwd(), assetFileName || "SourceCode.zip");
	await executeWithProgressBar("Download release asset...", Crawler.Download(assetDownloadUrl, localPath));

	if (extname(localPath) === ".zip") {
		const unzippedPath = join(process.cwd(), basename(localPath, ".zip"));
		await executeWithProgressBar("Extract downloaded release...", Crawler.unzip(localPath, unzippedPath));
		unlinkSync(localPath);

		if (localPath.endsWith("SourceCode.zip")) {
			const folders = readdirSync(unzippedPath);
			mv(join(unzippedPath, folders[0], "*"), unzippedPath);
			rm("-rf", join(unzippedPath, folders[0]));
		}

		localPath = unzippedPath;
	}

	return {
		releaseFileName: assetFileName,
		localPath
	};
}

async function getTrackByVersion(url: string): Promise<TrackVersionType> {
	const releases = await executeWithProgressBar("Checking for releases...", Crawler.GetReleases(url));
	let trackVersionBy: "branch" | "releases" = "branch";
	if (releases.length > 0) {
		console.log(`Found the following releases:\n  ${releases.slice(0, 5).map(r => `${r.tag_name}`).join("\n  ")}`);
		trackVersionBy = (await prompt([{
			name: "trackVersionBy",
			type: "list",
			message: "You can choose either to keep track of new releases by following a specific branch or by using the releases with semantic versioning. Please select your prefered way to keep the custom component up to date:",
			choices: [
				"releases",
				"branch",
			],
			default: "releases"
		}])).trackVersionBy;
	} else {
		console.log("No releases found.");
	}

	return trackVersionBy;
}

async function getBranches(url: string) {
	const parsedURL = Crawler.ParseURL(url);
	const response = await octokit.repos.listBranches({
		owner: parsedURL.owner,
		repo: parsedURL.repo
	});

	return response.data;
}

async function addNewComponent() {
	let githubUrl = (await prompt([{
		name: "githubUrl",
		type: "input",
		message: "Enter the GitHub URL of the custom component",
		validate: (i) => i.length === 0 ? "This field is required" : true
	}])).githubUrl;
	if (githubUrl.endsWith("/")) {
		githubUrl = githubUrl.substr(0, githubUrl.length - 1);
	}

	if (storage.hasCustomComponent(githubUrl)) {
		console.log("Component already registered");
		process.exit(1);
	}

	const customComponent: CustomComponent = {
		url: githubUrl,
		localPath: "",
		name: "",
		version: null,
		trackVersionBy: {} as TrackVersionByBranch | TrackVersionByReleases
	};

	// Check if the repository has releases specified to give the user the choice how to keep track of new versions
	customComponent.trackVersionBy.type = await getTrackByVersion(githubUrl);
	const hacsFile = await getHACSFile(githubUrl);

	// Download the latest release and check the content
	let localPath: string;
	if (customComponent.trackVersionBy.type === "releases") {
		const result = await downloadLatestRelease(githubUrl, hacsFile);
		localPath = result.localPath;
		customComponent.trackVersionBy.relaseFileName = result.releaseFileName;
		customComponent.trackVersionBy.semver = (await prompt([{
			name: "semver",
			type: "list",
			message: "Please choose what versions you would like to automatically update:",
			choices: [
				"patch",
				"minor",
				"major",
			],
			default: "patch"
		}])).semver;
	} else {
		const branches = await getBranches(githubUrl);
		customComponent.trackVersionBy.branchName = (await prompt([{
			name: "branchName",
			type: "list",
			message: "Please select the branch name you want to track:",
			choices: branches.map(b => b.name),
			default: "master"
		}])).branchName;

		localPath = await executeWithProgressBar(
			"Download branch archive...",
			Crawler.DownloadBranch(githubUrl, customComponent.trackVersionBy.branchName)
		);
	}

	if (statSync(localPath).isDirectory()) {
		customComponent.trackVersionBy.basePath = await getContentBaseDir(githubUrl, localPath, hacsFile);
	} else {
		customComponent.trackVersionBy.basePath = "";
	}

	// Ask the user where the custom component should be stored
	customComponent.localPath = (await prompt([{
		name: "localPath",
		type: "list",
		message: "Please select where the custom component should be stored:",
		choices: [
			"config/custom_components",
			"config/www/custom_components",
		]
	}])).localPath;

	customComponent.name = (await prompt([{
		name: "name",
		type: "input",
		message: "Please enter the name of the component:",
		default: Crawler.ParseURL(githubUrl).repo,
		validate: (i) => i.length === 0 ? "This field is required" : true
	}])).name;

	// Save new custom component
	storage.registerCustomComponent(customComponent);
	await Crawler.DownloadComponent(customComponent);

	console.log(`\nDone. The custom component ${customComponent.name} was downloaded to '${customComponent.localPath}'.`);
}

(async () => {

	let credentials: any;
	if (!storage.hasCredentials()) {
		credentials = (await prompt([{
			name: "credentials",
			type: "input",
			message: "The GitHub API is rate limited. The rate limit is higher for authentificated requests. Please enter a personal access token (goto https://github.com/settings/tokens/new):",
			validate: (i) => i.length === 0 ? "This field is required" : true
		}])).credentials;
		storage.setCredentials(credentials);
	} else {
		credentials = storage.getCredentials();
	}

	Crawler.SetCredentials(credentials);
	octokit = new Octokit({ auth: credentials });

	const steps = [
		"add a new custom component",
		"fetch registered components"
	];

	const nextStep = args.fetch
		? steps[1]
		: (await prompt([{
			name: "nextStep",
			type: "list",
			message: "What do you want to do?",
			choices: steps
		}])).nextStep;

	switch (nextStep) {
		case steps[0]:
			await addNewComponent();
			break;

		case steps[1]:
			await Crawler.FetchComponents(!args.fetch);
			break;
	}

	process.exit(0);

})();

// Hässlicher kleiner Wrapper, damit node nicht terminiert
// https://stackoverflow.com/questions/46966890/what-happens-when-a-promise-never-resolves
function wait() {
	setTimeout(wait, 1000);
}
