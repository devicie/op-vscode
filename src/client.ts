import { Client, createClient, DesktopAuth, Item } from "@1password/sdk";
import { window } from "vscode";
import { version } from "../package.json";
import { logger } from "./logger";
import { endWithPunctuation } from "./utils";

export const INTEGRATION_NAME = "1Password for VS Code";

export const createErrorHandler =
	(showError: boolean) => async (error: Error) => {
		const errorPrefix = "Error performing 1Password operation";

		let errorMessage = errorPrefix;
		if (error.message) {
			errorMessage += `: ${endWithPunctuation(error.message)}`;
		}

		logger.logError(errorMessage);

		if (!showError) {
			return;
		}

		await window.showErrorMessage(errorMessage);
	};

// Wraps the 1Password JavaScript SDK. Authentication is performed against the
// 1Password desktop app (with biometric unlock) using the account the user
// configured during setup. A client is created lazily and reused until the
// configured account changes.
export class OnePassword {
	private client?: Client;
	private accountName?: string;

	public get authenticated(): boolean {
		return Boolean(this.client);
	}

	// Set the account the SDK client should authenticate against. Changing the
	// account discards any existing client so the next operation re-authenticates.
	public setAccount(accountName?: string): void {
		if (this.accountName !== accountName) {
			this.accountName = accountName;
			this.client = undefined;
		}
	}

	public async getClient(showError = true): Promise<Client | undefined> {
		if (this.client) {
			return this.client;
		}

		if (!this.accountName) {
			return undefined;
		}

		try {
			this.client = await createClient({
				auth: new DesktopAuth(this.accountName),
				integrationName: INTEGRATION_NAME,
				integrationVersion: version,
			});
		} catch (error) {
			await createErrorHandler(showError)(error as Error);
			this.client = undefined;
		}

		return this.client;
	}

	public async isInvalid(): Promise<boolean> {
		return !(await this.getClient());
	}

	public async execute<TReturn>(
		command: (client: Client) => Promise<TReturn>,
		showError = true,
	): Promise<TReturn | undefined> {
		const client = await this.getClient(showError);
		if (!client) {
			return undefined;
		}

		try {
			return await command(client);
		} catch (error) {
			await createErrorHandler(showError)(error as Error);
			return undefined;
		}
	}

	// Resolve a full item from vault and item references, where either may be a
	// title or an ID. The SDK's `items.get` requires concrete IDs, so when a
	// reference isn't a valid ID we fall back to listing the vault to find a match.
	public async resolveItem(
		vaultRef: string,
		itemRef: string,
		showError = true,
	): Promise<Item | undefined> {
		return this.execute(async (client) => {
			const vaultId = await this.resolveVaultId(client, vaultRef);

			try {
				return await client.items.get(vaultId, itemRef);
			} catch {
				const items = await client.items.list(vaultId);
				const match = items.find(
					(i) => i.id === itemRef || i.title === itemRef,
				);

				if (!match) {
					throw new Error("Could not find vault item.");
				}

				return client.items.get(vaultId, match.id);
			}
		}, showError);
	}

	private async resolveVaultId(
		client: Client,
		vaultRef: string,
	): Promise<string> {
		const vaults = await client.vaults.list({ decryptDetails: true });
		const match = vaults.find((v) => v.id === vaultRef || v.title === vaultRef);
		return match ? match.id : vaultRef;
	}
}
