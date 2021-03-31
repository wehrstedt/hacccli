import { JsonDB } from 'node-json-db';
import { Config } from 'node-json-db/dist/lib/JsonDBConfig'

export interface CustomComponent {
	/** Url to the GitHub repository */
	url: string;

	name: string;

	trackVersionBy: TrackVersionByReleases | TrackVersionByBranch;

	/** Path where the custom component should be stored */
	localPath: string;

	/** Semver, Commit-Hash */
	version?: string | null;
}

export declare type TrackVersionType = "branch" | "releases";

export interface TrackVersionBy {
	type: TrackVersionType;
}

export interface TrackVersionByReleases extends TrackVersionBy {
	type: "releases";

	/** Specifies if the release is a zip file */
	zipRelease: boolean;

	/** Path where the files are located in the (unzipped) release (empty string = root dir) */
	basePath: string;

	/** Auto update the following versions */
	semver: "patch" | "minor" | "major";

	/** Name of the asset which should be downloaded from a release */
	relaseFileName: string;
}

export interface TrackVersionByBranch extends TrackVersionBy {
	type: "branch";

	/** Name of the branch which should be tracked */
	branchName: string;

	/** Path where the files are located in the release (empty string = root dir) */
	basePath: string;
}

export class Storage {

	private db: JsonDB;

	constructor() {
		this.db = new JsonDB(new Config("hacccli-db", true, false));
		this.db.load();
	}

	public hasCredentials() {
		return this.db.exists("/credentials");
	}

	public getCredentials(): string {
		return this.db.getData("/credentials");
	}

	public setCredentials(credentials: string) {
		this.db.push("/credentials", credentials, true);
	}

	public hasCustomComponent(url: string) {
		return this.getCustomComponents().some(c => c.url === url);
	}

	public registerCustomComponent(component: CustomComponent) {
		if (this.hasCustomComponent(component.url)) {
			throw new Error("Component already registered");
		}

		const components = this.getCustomComponents();
		component.version = null;
		components.push(component);
		this.db.push("/registered-components", components, true);
		this.db.save();
	}

	public updateCustomComponent(component: CustomComponent) {
		let index = -1;
		const components = this.getCustomComponents();
		components.some((c, i) => {
			if (c.url === component.url) {
				index = i;
			}
		});

		if (index > -1) {
			components[index] = component;
			this.db.push("/registered-components", components, true);
			this.db.save();
		} else {
			throw new Error("Component is not registered");
		}
	}

	public getCustomComponents(): CustomComponent[] {
		this.db.reload();
		if (this.db.exists("/registered-components")) {
			return this.db.getData("/registered-components");
		} else {
			return [];
		}
	}
}
