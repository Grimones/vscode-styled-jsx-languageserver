import * as ts from 'typescript';
import { TextDocument } from 'vscode-languageserver-types';
import { Stylesheet } from 'vscode-css-languageservice';
import { LanguageModelCache } from './language-model-cache';

export interface StyledJsxTaggedTemplate {
    start: number;
    end: number;
}

export interface StyledJsx {
    cssDocument: TextDocument;
    stylesheet: Stylesheet;
}

const styledJsxPattern = /((<\s*?style\s*?(global)?\s*?jsx\s*?(global)?\s*?>)|(\s*?css\s*?`))/g;
export function getApproximateStyledJsxOffsets(document: TextDocument): number[] {
    const results = [];
    const doc = document.getText();
    while (styledJsxPattern.exec(doc)) {
        results.push(styledJsxPattern.lastIndex);
    }
    return results;
}

function getTemplateString(node: ts.Node) {
    if (ts.isTemplateHead(node) || ts.isTemplateLiteral(node)) {
        if (ts.isTemplateHead(node)) {
            return node.parent;
        } else {
            return node;
        }
    }

    return undefined;
}

// css`button { position: relative; }`
export function isStyledJsxTaggedTemplate(templateNode: ts.TemplateExpression | ts.TemplateLiteral): boolean {
    const parent = templateNode.parent;

    if (ts.isTaggedTemplateExpression(parent)) {
        if (parent.tag.getText() === 'css') {
            return true;
        }
    }

    return false;
}

function walk(node: ts.Node, callback: (node: ts.Node) => void) {
    if (
        ts.isJSDoc(node) ||
        node.kind === ts.SyntaxKind.MultiLineCommentTrivia ||
        node.kind === ts.SyntaxKind.SingleLineCommentTrivia
    ) {
        return;
    }

    if (ts.isToken(node) && node.kind !== ts.SyntaxKind.EndOfFileToken) {
        callback(node);
    } else {
        node.getChildren().forEach(child => walk(child, callback));
    }
}

function isStyledJsxTemplate(node: ts.Node) {
    if (!ts.isJsxExpression(node.parent)) {
        return false;
    }

    const grandparent = node.parent.parent;

    if (!ts.isJsxElement(grandparent)) {
        return false;
    }

    const opener = grandparent.openingElement;

    if (opener.tagName.getText() !== 'style') {
        return false;
    }

    for (const prop of opener.attributes.properties) {
        if (prop.name && prop.name.getText() === 'jsx') {
            return true;
        }
    }

    return false;
}

export function findStyledJsxTaggedTemplate(
    textDocument: TextDocument,
    cursorOffsets: number[]
): StyledJsxTaggedTemplate[] {
    const source = ts.createSourceFile(
        'tmp',
        textDocument.getText(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JSX | ts.ScriptKind.TSX
    );

    const templates: StyledJsxTaggedTemplate[] = [];

    walk(source, node => {
        const templateNode = getTemplateString(node);

        if (templateNode) {
            if (isStyledJsxTaggedTemplate(templateNode) || isStyledJsxTemplate(templateNode)) {
                templates.push({ start: templateNode.getStart() + 1, end: templateNode.getEnd() - 1 });
            }
        }
    });

    return templates;
}

const expressionPattern = /(\${.*})|(&&|\|\|)/g;
// I guess so long functions are bad. Don't know how to properly format in typescript.
export function replaceAllWithSpacesExceptCss(
    textDocument: TextDocument,
    styledJsxTaggedTemplates: StyledJsxTaggedTemplate[],
    stylesheets: LanguageModelCache<Stylesheet>
): { cssDocument: TextDocument; stylesheet: Stylesheet } {
    const text = textDocument.getText();
    let result = '';
    // code that goes before CSS
    result += text.slice(0, styledJsxTaggedTemplates[0].start).replace(/./g, ' ');

    for (let i = 0; i < styledJsxTaggedTemplates.length; i++) {
        // CSS itself with dirty hacks. Maybe there is better solution.
        // We need to find all expressions in css and replace each character of expression with space.
        // This is neccessary to preserve character count
        result += text
            .slice(styledJsxTaggedTemplates[i].start, styledJsxTaggedTemplates[i].end)
            .replace(expressionPattern, (str, p1) => {
                return p1.replace(/./g, 'a');
            });
        // if there is several CSS parts
        if (i + 1 < styledJsxTaggedTemplates.length) {
            // code that is in between that CSS parts
            result += text
                .slice(styledJsxTaggedTemplates[i].end, styledJsxTaggedTemplates[i + 1].start)
                .replace(/./g, ' ');
        }
    }
    // code that goes after CSS
    result += text
        .slice(styledJsxTaggedTemplates[styledJsxTaggedTemplates.length - 1].end, text.length)
        .replace(/./g, ' ');

    const cssDocument = TextDocument.create(textDocument.uri.toString(), 'css', textDocument.version, result);
    const stylesheet = stylesheets.get(cssDocument);

    return {
        cssDocument,
        stylesheet
    };
}

export function getStyledJsx(
    document: TextDocument,
    stylesheets: LanguageModelCache<Stylesheet>
): StyledJsx | undefined {
    const styledJsxOffsets = getApproximateStyledJsxOffsets(document);
    if (styledJsxOffsets.length > 0) {
        const styledJsxTaggedTemplates = findStyledJsxTaggedTemplate(document, styledJsxOffsets);
        if (styledJsxTaggedTemplates.length > 0) {
            return replaceAllWithSpacesExceptCss(document, styledJsxTaggedTemplates, stylesheets);
        }
    }
    return undefined;
}

export function getStyledJsxUnderCursor(
    document: TextDocument,
    stylesheets: LanguageModelCache<Stylesheet>,
    cursorOffset: number
): StyledJsx | undefined {
    const styledJsxTaggedTemplates = findStyledJsxTaggedTemplate(document, [cursorOffset]);

    if (
        styledJsxTaggedTemplates.length > 0 &&
        styledJsxTaggedTemplates[0].start < cursorOffset &&
        styledJsxTaggedTemplates[0].end > cursorOffset
    ) {
        return replaceAllWithSpacesExceptCss(document, styledJsxTaggedTemplates, stylesheets);
    }
    return undefined;
}
