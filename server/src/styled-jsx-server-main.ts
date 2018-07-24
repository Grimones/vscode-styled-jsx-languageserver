/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {
	createConnection, IConnection, TextDocuments, InitializeParams, InitializeResult, ServerCapabilities
} from 'vscode-languageserver';

import { TextDocument } from 'vscode-languageserver-types';

import { ConfigurationRequest } from 'vscode-languageserver-protocol/lib/protocol.configuration';
import { DocumentColorRequest, ColorServerCapabilities as CPServerCapabilities, ColorPresentationRequest } from 'vscode-languageserver-protocol/lib/protocol.colorProvider';

import { getSCSSLanguageService, LanguageSettings, Stylesheet } from 'vscode-css-languageservice';
import { getLanguageModelCache } from './language-model-cache';

import { getStyledJsx, getStyledJsxUnderCursor } from './styled-jsx-utils'


// Create a connection for the server.
let connection: IConnection = createConnection();

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

let stylesheets = getLanguageModelCache<Stylesheet>(10, 60, document => cssLanguageService.parseStylesheet(document));
documents.onDidClose(e => {
	stylesheets.onDocumentRemoved(e.document);
});
connection.onShutdown(() => {
	stylesheets.dispose();
});

let scopedSettingsSupport = false;
// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((params: InitializeParams): InitializeResult => {
	function hasClientCapability(name: string) {
		let keys = name.split('.');
		let c: any = params.capabilities;
		for (let i = 0; c && i < keys.length; i++) {
			c = c[keys[i]];
		}
		return !!c;
	}
	let snippetSupport = hasClientCapability('textDocument.completion.completionItem.snippetSupport');
	scopedSettingsSupport = hasClientCapability('workspace.configuration');
	let capabilities: ServerCapabilities & CPServerCapabilities = {
		// Tell the client that the server works in FULL text document sync mode
		textDocumentSync: documents.syncKind,
		completionProvider: snippetSupport ? { resolveProvider: false } : undefined,
		hoverProvider: true,
		documentSymbolProvider: true,
		referencesProvider: true,
		definitionProvider: true,
		documentHighlightProvider: true,
		codeActionProvider: true,
		renameProvider: false,
		colorProvider: true
	};
	return { capabilities };
});

const cssLanguageService = getSCSSLanguageService();

let documentSettings: { [key: string]: Thenable<LanguageSettings | undefined> } = {};
// remove document settings on close
documents.onDidClose(e => {
	delete documentSettings[e.document.uri];
});
function getDocumentSettings(textDocument: TextDocument): Thenable<LanguageSettings | undefined> {
	if (scopedSettingsSupport) {
		let promise = documentSettings[textDocument.uri];
		if (!promise) {
			let configRequestParam = { items: [{ scopeUri: textDocument.uri, section: 'css' }] };
			promise = connection.sendRequest(ConfigurationRequest.type, configRequestParam).then(s => s[0]);
			documentSettings[textDocument.uri] = promise;
		}
		return promise;
	}
	return Promise.resolve(void 0);
}

// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration(change => {
	updateConfiguration(<LanguageSettings>change.settings.css);
});

function updateConfiguration(settings: LanguageSettings) {
	cssLanguageService.configure(settings)
	// reset all document settings
	documentSettings = {};
	// Revalidate any open text documents
	documents.all().forEach(triggerValidation);
}

let pendingValidationRequests: { [uri: string]: NodeJS.Timer } = {};
const validationDelayMs = 200;

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	triggerValidation(change.document);
});

// a document has closed: clear all diagnostics
documents.onDidClose(event => {
	clearDiagnostics(event.document);
});

function clearDiagnostics(document: TextDocument) {
	cleanPendingValidation(document);
	connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
}

function cleanPendingValidation(textDocument: TextDocument): void {
	let request = pendingValidationRequests[textDocument.uri];
	if (request) {
		clearTimeout(request);
		delete pendingValidationRequests[textDocument.uri];
	}
}

function triggerValidation(textDocument: TextDocument): void {
	cleanPendingValidation(textDocument);
	pendingValidationRequests[textDocument.uri] = setTimeout(() => {
		delete pendingValidationRequests[textDocument.uri];
		validateTextDocument(textDocument);
	}, validationDelayMs);
}

function validateTextDocument(document: TextDocument): void {
	let settingsPromise = getDocumentSettings(document);
	settingsPromise.then(settings => {
		const styledJsx = getStyledJsx(document, stylesheets);
		if (styledJsx) {
			const { cssDocument, stylesheet } = styledJsx;
			let diagnostics = cssLanguageService.doValidation(cssDocument, stylesheet, settings);
			connection.sendDiagnostics({ uri: document.uri, diagnostics });
		}
		else {
			clearDiagnostics(document);
		}
	});
}

connection.onCompletion(textDocumentPosition => {
	const document = documents.get(textDocumentPosition.textDocument.uri);
	if (!document) return null;

	const cursorOffset = document.offsetAt(textDocumentPosition.position);

	const styledJsx = getStyledJsxUnderCursor(document, stylesheets, cursorOffset);

	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.doComplete(cssDocument, textDocumentPosition.position, stylesheet)
	}
	return null;
});

connection.onHover(textDocumentPosition => {
	let document = documents.get(textDocumentPosition.textDocument.uri);
	if (!document) return null;

	const styledJsx = getStyledJsx(document, stylesheets);
	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.doHover(cssDocument, textDocumentPosition.position, stylesheet)
	}
	return null;
});

connection.onDocumentSymbol(documentSymbolParams => {
	let document = documents.get(documentSymbolParams.textDocument.uri);
	if (!document) return null;

	const styledJsx = getStyledJsx(document, stylesheets);
	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.findDocumentSymbols(cssDocument, stylesheet);
	}
	return null;
});

connection.onDefinition(documentSymbolParams => {
	let document = documents.get(documentSymbolParams.textDocument.uri);
	if (!document) return null;

	const styledJsx = getStyledJsx(document, stylesheets);
	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.findDefinition(cssDocument, documentSymbolParams.position, stylesheet);
	}
	return null;
});

connection.onDocumentHighlight(documentSymbolParams => {
	let document = documents.get(documentSymbolParams.textDocument.uri);
	if (!document) return null;

	const styledJsx = getStyledJsx(document, stylesheets);
	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.findDocumentHighlights(cssDocument, documentSymbolParams.position, stylesheet);
	}
	return null;
});

connection.onReferences(referenceParams => {
	let document = documents.get(referenceParams.textDocument.uri);
	if (!document) return null;

	const styledJsx = getStyledJsx(document, stylesheets);
	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.findReferences(cssDocument, referenceParams.position, stylesheet);
	}
	return null;
});

connection.onCodeAction(codeActionParams => {
	let document = documents.get(codeActionParams.textDocument.uri);
	if (!document) return null;

	const styledJsx = getStyledJsx(document, stylesheets);
	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.doCodeActions(cssDocument, codeActionParams.range, codeActionParams.context, stylesheet);
	}
	return null;
});

connection.onRequest(DocumentColorRequest.type, params => {
	let document = documents.get(params.textDocument.uri);
	if (document) {
		const styledJsx = getStyledJsx(document, stylesheets);
		if (styledJsx) {
			const { cssDocument, stylesheet } = styledJsx;
			return cssLanguageService.findDocumentColors(cssDocument, stylesheet);
		}
	}
	return [];
});

connection.onRequest(ColorPresentationRequest.type, params => {
	let document = documents.get(params.textDocument.uri);
	if (document) {
		const styledJsx = getStyledJsx(document, stylesheets);
		if (styledJsx) {
			const { cssDocument, stylesheet } = styledJsx;
			return cssLanguageService.getColorPresentations(cssDocument, stylesheet, params.color, params.range);
		}
	}
	return [];
});

connection.onRenameRequest(renameParameters => {
	let document = documents.get(renameParameters.textDocument.uri);
	if (!document) return null;

	const styledJsx = getStyledJsx(document, stylesheets);
	if (styledJsx) {
		const { cssDocument, stylesheet } = styledJsx;
		return cssLanguageService.doRename(cssDocument, renameParameters.position, renameParameters.newName, stylesheet);
	}
	return null;
});

// Listen on the connection
connection.listen();
