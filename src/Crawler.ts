// @ts-ignore
import Downloader = require("nodejs-file-downloader");
import { Octokit } from "@octokit/rest";
import { createReadStream, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { mkdir, mv, rm } from "shelljs";
import { Extract } from "unzipper";
import { CustomComponent, Storage, TrackVersionByReleases } from "./Storage";
import { lt, gt, minor, valid, patch } from "semver";
import { prompt } from "inquirer";

export class Crawler {

	protected static storage: Storage = new Storage();
	protected static octokit: Octokit = new Octokit({
		auth: Crawler.storage.hasCredentials() ? Crawler.storage.getCredentials() : undefined
	});

	public static SetCredentials(credentials: string) {
		Crawler.octokit = new Octokit({
			auth: credentials
		});
	}

	public static async DownloadComponent(component: CustomComponent, interactive: boolean = false) {
		let localPath = "";
		if (component.trackVersionBy.type === "branch") {
			let downloadBranch = true;
			if (component.version) {
				const response = await this.octokit.repos.getBranch({
					owner: this.ParseURL(component.url).owner,
					repo: this.ParseURL(component.url).repo,
					branch: component.trackVersionBy.branchName
				});

				if (response.data.commit.sha.startsWith(component.version)) {
					downloadBranch = false;
				}
			}

			if (downloadBranch) {
				localPath = await Crawler.DownloadBranch(component.url, component.trackVersionBy.branchName);
				const matches = localPath.match(/.+-(.+)$/);
				if (matches) {
					component.version = matches[1];
				} else {
					throw new Error("Cannot determine version");
				}
			}
		} else {
			let releaseToDownload;
			if (component.version) {
				// find a suitable release which is greater than the current installed
				const releases = await Crawler.GetReleases(component.url);
				const allGreaterReleases = releases
					.filter(r => valid(r.tag_name))
					.filter(r => gt(r.tag_name, component.version as string));
				if (allGreaterReleases.length > 0) {
					if (component.trackVersionBy.semver === "major") {
						// no further filtering neccessary. just use the latest version
						releaseToDownload = allGreaterReleases[0];
					} else if (component.trackVersionBy.semver === "minor") {
						releaseToDownload = allGreaterReleases.filter(r => minor(r.tag_name) > minor(component.version as string))[0];
					} else {
						releaseToDownload = allGreaterReleases.filter(r => patch(r.tag_name) > patch(component.version as string))[0];
					}

					if (!releaseToDownload) {
						if (interactive) {
							// There are new versions available, but non of these matches component.trackVersionBy.semver
							// ask the user if he wants to upgrade
							const newVersionTagName = await prompt([{
								name: "newVersionTagName",
								type: "list",
								choices: [...allGreaterReleases.map(r => r.tag_name), "<skip>"],
								message: `The following new releases are available, but none of these matching your constraint <${component.trackVersionBy.semver}> for current installed version '${component.version}'. If you like to upgrade, select the version you like to install. Otherwise, select <skip>:`,
								default: "<skip>"
							}]);

							if (newVersionTagName.newVersionTagName !== "<skip>") {
								releaseToDownload = allGreaterReleases.filter(r => r.tag_name === newVersionTagName.newVersionTagName)[0];
							}
						} else {
							console.log(`New versions available for ${component.name}, but none of these matching your constraint <${component.trackVersionBy.semver}> for current installed version '${component.version}'. Consider to upgrade the custom component by calling the cli-tool and select command 'fetch registered components'.`);
						}
					}
				}
			} else {
				releaseToDownload = await Crawler.GetLatestRelease(component.url);
			}

			if (releaseToDownload) {
				let assetDownloadUrl = "";
				if (releaseToDownload.assets.length === 0) {
					assetDownloadUrl = `${component.url}/archive/refs/tags/${releaseToDownload.tag_name}.zip`;
					localPath = join(process.cwd(), "SourceCode.zip");
				} else {
					const assetToDownload = releaseToDownload.assets.filter(a =>
						a.name === (component.trackVersionBy as TrackVersionByReleases).relaseFileName
					)[0];
					localPath = join(process.cwd(), assetToDownload.name);
					assetDownloadUrl = assetToDownload.browser_download_url;
				}

				await Crawler.Download(assetDownloadUrl, localPath);

				if (extname(localPath) === ".zip") {
					const unzippedPath = join(process.cwd(), basename(localPath, ".zip"));
					await Crawler.unzip(localPath, unzippedPath);
					rm("-r", localPath);

					if (localPath.endsWith("SourceCode.zip")) {
						const folders = readdirSync(unzippedPath);
						mv(join(unzippedPath, folders[0], "*"), unzippedPath);
						rm("-r", join(unzippedPath, folders[0]));
					}

					localPath = unzippedPath;
				}

				component.version = valid(releaseToDownload.tag_name);
			}
		}

		if (localPath) {
			let folderToDelete = localPath;
			if (component.trackVersionBy.basePath) {
				localPath = join(localPath, component.trackVersionBy.basePath);
			}

			const targetPath = join(component.localPath, component.name);
			if (existsSync(targetPath)) {
				rm("-r", targetPath);
			}

			mkdir("-p", targetPath);

			let sourcePath = localPath;
			if (statSync(localPath).isDirectory()) {
				sourcePath = join(localPath, "/*");
			} else {
				folderToDelete = "";
			}

			mv(sourcePath, targetPath);
			if (folderToDelete) {
				rm("-r", folderToDelete);
			}

			this.storage.updateCustomComponent(component);
			console.log(`${component.name} downloaded to ${targetPath}`);
		} else {
			console.log(`No new version available for component ${component.name}.`);
		}
	}

	public static async Download(downloadUrl: string, localPath: string) {
		if (existsSync(localPath)) {
			rm("-r", localPath);
		}

		const filesBefore = readdirSync(dirname(localPath));
		const downloader = new Downloader({
			url: downloadUrl,
			directory: dirname(localPath)
		});

		await downloader.download();

		const filesAfterSet = new Set(readdirSync(dirname(localPath)));
		for (const fileBefore of filesBefore) {
			filesAfterSet.delete(fileBefore);
		}

		const filesAfter = [...filesAfterSet.keys()];
		if (filesAfter.length > 1) {
			throw new Error("Found more than one new file");
		} else if (filesAfter.length === 0) {
			throw new Error("No new file found");
		}

		mv(filesAfter[0], localPath);
	}


	/**
	 * Downloads the branch as archive and unzip the archive
	 * @param url
	 * @param branchName
	 * @returns Path to the unzipped archive
	 */
	public static async DownloadBranch(url: string, branchName: string) {
		const parsedURL = Crawler.ParseURL(url);
		const response = await this.octokit.rest.repos.downloadZipballArchive({
			owner: parsedURL.owner,
			repo: parsedURL.repo,
			ref: branchName
		});

		const localPath = join(process.cwd(), branchName + ".zip");
		if (existsSync(localPath)) {
			rm("-r", localPath);
		}

		writeFileSync(localPath, Buffer.from(response.data as ArrayBuffer));

		const unzippedPath = join(process.cwd(), "unzipped");
		await this.unzip(localPath, unzippedPath);
		rm("-r", localPath);

		// If a branch is downloaded, the content will be inside of a subdirectory
		const folders = readdirSync(unzippedPath);
		mv(join(unzippedPath, folders[0], "/*"), unzippedPath);
		rm("-r", join(unzippedPath, folders[0]));
		return unzippedPath;
	}

	public static async FetchComponents(interactive: boolean) {
		const components = this.storage.getCustomComponents();
		for (const component of components) {
			console.log(`Start fetch component ${component.name}`);
			await this.DownloadComponent(component, interactive);
			console.log(`  => Finished.\n`);
		}
	}

	public static async GetLatestRelease(url: string) {
		const parsedURL = Crawler.ParseURL(url);
		const response = await this.octokit.rest.repos.getLatestRelease({
			owner: parsedURL.owner,
			repo: parsedURL.repo
		});

		return response.data;
	}

	/**
	 * Returns all releases found for the repository
	 * @param url
	 */
	public static async GetReleases(url: string) {
		const parsedURL = Crawler.ParseURL(url);
		const response = await this.octokit.rest.repos.listReleases({
			owner: parsedURL.owner,
			repo: parsedURL.repo
		});

		return response.data.filter(r => valid(r.tag_name)).sort((a, b) => {
			if (lt(a.tag_name, b.tag_name)) {
				return -1;
			} else if (gt(a.tag_name, b.tag_name)) {
				return 1;
			} else {
				return 0;
			}
		}).reverse();
	}

	public static ParseURL(url: string) {
		const matches = url.match(/http?s:\/\/github.com\/([^/]+)\/([^.]+)(.git)?/);
		if (matches) {
			return {
				owner: matches[1],
				repo: matches[2]
			};
		} else {
			throw new Error("Cannot parse url");
		}
	}

	public static async unzip(filePath: string, outputPath: string) {
		return new Promise<void>(async (resolve, reject) => {
			if (existsSync(outputPath)) {
				rm("-r", outputPath);
			}

			createReadStream(filePath)
				.pipe(Extract({
					path: outputPath
				}).on("close", resolve));
		});
	}

}
