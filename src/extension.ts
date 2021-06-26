/**
 * TODO:
 * [ ] When text is selected, use that to fill the fzf prompt
 * [ ] Show relative paths whenever possible
 *     - This might be tricky. I could figure out the common base path of all dirs we search, I guess?
 *
 * Feature options:
 * [ ] Buffer of open files / show currently open files / always show at bottom => workspace.textDocuments is a bit curious / borked
 */

import { tmpdir } from 'os';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import assert = require('assert');
// Let's keep it DRY and load the package here so we can reuse some data from it
let PACKAGE: any;
// Reference to the terminal we use
let term: vscode.Terminal;

//
// Define the commands we expose. URIs are populated upon extension activation
// because only then we'll know the actual paths.
//
interface Command {
    script: string,
    uri: vscode.Uri | undefined,
}
const commands: { [key: string]: Command } = {
    findFiles: {
        script: 'find_files.sh',
        uri: undefined,
    },
    findWithinFiles: {
        script: 'find_within_files.sh',
        uri: undefined,
    },
    flightCheck: {
        script: 'flight_check.sh',
        uri: undefined,
    }
};

/** Global variable cesspool erm, I mean, Configuration Data Structure! It does the job for now. */
interface Config {
    extensionName: string | undefined,
    folders: string[],
    disableStartupChecks: boolean,
    useEditorSelectionAsQuery: boolean,
    useWorkspaceSearchExcludes: boolean,
    findFilesPreviewEnabled: boolean,
    findFilesPreviewCommand: string,
    findFilesPreviewWindowConfig: string,
    findWithinFilesPreviewEnabled: boolean,
    findWithinFilesPreviewCommand: string,
    findWithinFilesPreviewWindowConfig: string,
    workspaceSettings: {
        folders: string[],
    },
    canaryFile: string,
    selectionFile: string,
    hideTerminalAfterSuccess: boolean,
    hideTerminalAfterFail: boolean,
    clearTerminalAfterUse: boolean,
    showMaximizedTerminal: boolean,
    flightCheckPassed: boolean,
    defaultSearchLocation: string,
    extensionPath: string,
};
const CFG: Config = {
    extensionName: undefined,
    folders: [],
    disableStartupChecks: false,
    useEditorSelectionAsQuery: true,
    useWorkspaceSearchExcludes: true,
    findFilesPreviewEnabled: true,
    findFilesPreviewCommand: '',
    findFilesPreviewWindowConfig: '',
    findWithinFilesPreviewEnabled: true,
    findWithinFilesPreviewCommand: '',
    findWithinFilesPreviewWindowConfig: '',
    workspaceSettings: {
        folders: [],
    },
    canaryFile: '',
    selectionFile: '',
    hideTerminalAfterSuccess: false,
    hideTerminalAfterFail: false,
    clearTerminalAfterUse: false,
    showMaximizedTerminal: false,
    flightCheckPassed: false,
    defaultSearchLocation: '',
    extensionPath: '',
};

/** Ensure that whatever command we expose in package.json actually exists */
function checkExposedFunctions() {
    for (const x of PACKAGE.contributes.commands) {
        const fName = x.command.substr(PACKAGE.name.length + '.'.length);
        assert(fName in commands);
    }
}

/** We need the extension context to get paths to our scripts. We do that here. */
function setupConfig(context: vscode.ExtensionContext) {
    CFG.extensionName = PACKAGE.name;
    assert(CFG.extensionName);
    const local = (x: string) => vscode.Uri.file(path.join(context.extensionPath, x));
    commands.findFiles.uri = local(commands.findFiles.script);
    commands.findWithinFiles.uri = local(commands.findWithinFiles.script);
    commands.flightCheck.uri = local(commands.flightCheck.script);
}

/** Register the commands we defined with VS Code so users have access to them */
function registerCommands() {
    Object.keys(commands).map((k) => {
        vscode.commands.registerCommand(`${CFG.extensionName}.${k}`, () => {
            executeTerminalCommand(k);
        });
    });
}

/** Entry point called by VS Code */
export function activate(context: vscode.ExtensionContext) {
    CFG.extensionPath = context.extensionPath;
    const local = (x: string) => vscode.Uri.file(path.join(CFG.extensionPath, x));

    // Load our package.json
    PACKAGE = JSON.parse(fs.readFileSync(local('package.json').fsPath, 'utf-8'));
    setupConfig(context);
    checkExposedFunctions();

    handleWorkspaceFoldersChanges();
    handleWorkspaceSettingsChanges();

    registerCommands();
    reinitialize();
}

/* Called when extension is deactivated by VS Code */
export function deactivate() {
    term?.dispose();
    fs.rmSync(CFG.canaryFile, { force: true });
    fs.rmSync(CFG.selectionFile, { force: true });
}

/** Map settings from the user-configurable settings to our internal data structure */
function updateConfigWithUserSettings() {
    function getCFG<T>(key: string) {
        const userCfg = vscode.workspace.getConfiguration();
        const ret = userCfg.get<T>(`${CFG.extensionName}.${key}`);
        assert(ret !== undefined);
        return ret;
    }

    CFG.disableStartupChecks = getCFG('advanced.disableStartupChecks');
    CFG.useEditorSelectionAsQuery = getCFG('advanced.useEditorSelectionAsQuery');
    CFG.useWorkspaceSearchExcludes = getCFG('general.useWorkspaceSearchExcludes');
    CFG.defaultSearchLocation = getCFG('general.defaultSearchLocation');
    CFG.hideTerminalAfterSuccess = getCFG('general.hideTerminalAfterSuccess');
    CFG.hideTerminalAfterFail = getCFG('general.hideTerminalAfterFail');
    CFG.clearTerminalAfterUse = getCFG('general.clearTerminalAfterUse');
    CFG.showMaximizedTerminal = getCFG('general.showMaximizedTerminal');
    CFG.findFilesPreviewEnabled = getCFG('findFiles.showPreview');
    CFG.findFilesPreviewCommand = getCFG('findFiles.previewCommand');
    CFG.findFilesPreviewWindowConfig = getCFG('findFiles.previewWindowConfig');
    CFG.findWithinFilesPreviewEnabled = getCFG('findWithinFiles.showPreview');
    CFG.findWithinFilesPreviewCommand = getCFG('findWithinFiles.previewCommand');
    CFG.findWithinFilesPreviewWindowConfig = getCFG('findWithinFiles.previewWindowConfig');
}

function handleWorkspaceFoldersChanges() {
    const updateFolders = () => {
        const dirs = vscode.workspace.workspaceFolders;
        if (dirs === undefined) {
            CFG.folders = ['.'];   // best we can do
        } else {
            CFG.folders = dirs.map(x => {
                const uri = decodeURI(x.uri.toString());
                if (uri.substr(0, 7) === 'file://') {
                    return uri.substr(7);
                } else {
                    vscode.window.showErrorMessage('Non-file:// uri\'s not currently supported...');
                    return '';
                }
            });
        }
    };

    updateFolders();

    // Also re-update when anything changes
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
        console.log('workspace folders changed: ', event);
        updateFolders();
    });
}

function handleWorkspaceSettingsChanges() {
    vscode.workspace.onDidChangeConfiguration(_ => {
        updateConfigWithUserSettings();
        // We need to update the env vars in the terminal
        reinitialize();
    });
}

/** Check seat belts are on. Also, check terminal commands are on PATH */
function doFlightCheck(): boolean {
    const parseKeyValue = (line: string) => {
        return line.split(': ', 2);
    };

    try {
        let errStr = '';
        const kvs: any = {};
        const out = cp.execFileSync(getCommandString(commands.flightCheck, false, true), { shell: true }).toString('utf-8');
        out.split('\n').map(x => {
            const maybeKV = parseKeyValue(x);
            if (maybeKV.length === 2) {
                kvs[maybeKV[0]] = maybeKV[1];
            }
        });
        if (kvs['which bat'] === undefined || kvs['which bat'] === '') {
            errStr += 'bat not found on your PATH\n. ';
        }
        if (kvs['which fzf'] === undefined || kvs['which fzf'] === '') {
            errStr += 'fzf not found on your PATH\n. ';
        }
        if (kvs['which rg'] === undefined || kvs['which rg'] === '') {
            errStr += 'rg not found on your PATH\n. ';
        }
        if (errStr !== '') {
            vscode.window.showErrorMessage(`Failed to activate plugin: ${errStr}\nMake sure you have the required command line tools installed as outlined in the README.`);
        }

        return errStr === '';
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to run checks before starting extension. Maybe this is helpful: ${error}`);
        return false;
    }
}

/**
 * All the logic that's the same between starting the plugin and re-starting
 * after user settings change
 */
function reinitialize() {

    term?.dispose();
    updateConfigWithUserSettings();
    // console.log('plugin config:', CFG);
    if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
        CFG.flightCheckPassed = doFlightCheck();
    }

    if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
        return false;
    }

    //
    // Set up a file watcher. Its contents tell us what files the user selected.
    // It also means the command was completed so we can do stuff like
    // optionally hiding the terminal.
    //
    const tmpDir = fs.mkdtempSync(`${tmpdir()}${path.sep}${CFG.extensionName}-`);
    CFG.canaryFile = path.join(tmpDir, 'snitch');
    CFG.selectionFile = path.join(tmpDir, 'selection');
    fs.writeFileSync(CFG.canaryFile, '');
    fs.watch(CFG.canaryFile, (eventType) => {
        if (eventType === 'change') {
            handleCanaryFileChange();
        } else if (eventType === 'rename') {
            vscode.window.showErrorMessage(`Issue detected with extension ${CFG.extensionName}. You may have to reload it.`);
        }
    });
    return true;
}

/** Interpreting the terminal output and turning them into a vscode command */
function openFiles(data: string) {
    const filePaths = data.split('\n').filter(s => s !== '');
    assert(filePaths.length > 0);
    filePaths.forEach(p => {
        const [file, lineTmp, charTmp] = p.split(':', 3);
        let line = 0, char = 0;
        let range = new vscode.Range(0, 0, 0, 0);
        if (lineTmp !== undefined) {
            if (charTmp !== undefined) {
                char = parseInt(charTmp) - 1;  // 1 based in rg, 0 based in VS Code
            }
            line = parseInt(lineTmp) - 1;  // 1 based in rg, 0 based in VS Code
            assert(line >= 0);
            assert(char >= 0);
        }
        vscode.window.showTextDocument(
            vscode.Uri.file(file),
            { preview: false, selection: new vscode.Range(line, char, line, char) });
    });
}

/** Logic of what to do when the user completed a command invocation on the terminal */
function handleCanaryFileChange() {
    if (CFG.clearTerminalAfterUse) {
        term.sendText('clear');
    }

    fs.readFile(CFG.canaryFile, { encoding: 'utf-8' }, (err, data) => {
        if (err) {
            // We shouldn't really end up here. Maybe leave the terminal around in this case...
            vscode.window.showWarningMessage('Something went wrong but we don\'t know what... Did you clean out your /tmp folder?');
        } else {
            const commandWasSuccess = data.length > 0 && data[0] !== '1';

            // open the file(s)
            if (commandWasSuccess) {
                openFiles(data);
            }

            if (commandWasSuccess && CFG.hideTerminalAfterSuccess) {
                term.hide();
            } else if (!commandWasSuccess && CFG.hideTerminalAfterFail) {
                term.hide();
            } else {
                // Don't hide the terminal and make clippy angry
            }
        }
    });
}

function createTerminal() {
    term = vscode.window.createTerminal({
        name: 'F️indItFaster',
        hideFromUser: true,
        env: {
            /* eslint-disable @typescript-eslint/naming-convention */
            HISTCONTROL: 'ignoreboth',  // bash
            // HISTORY_IGNORE: '*',        // zsh
            FIND_FILES_PREVIEW_ENABLED: CFG.findFilesPreviewEnabled ? '1' : '0',
            FIND_FILES_PREVIEW_COMMAND: CFG.findFilesPreviewCommand,
            FIND_FILES_PREVIEW_WINDOW_CONFIG: CFG.findFilesPreviewWindowConfig,
            FIND_WITHIN_FILES_PREVIEW_ENABLED: CFG.findWithinFilesPreviewEnabled ? '1' : '0',
            FIND_WITHIN_FILES_PREVIEW_COMMAND: CFG.findWithinFilesPreviewCommand,
            FIND_WITHIN_FILES_PREVIEW_WINDOW_CONFIG: CFG.findWithinFilesPreviewWindowConfig,
            GLOBS: CFG.useWorkspaceSearchExcludes ? getIgnoreString() : '',
            CANARY_FILE: CFG.canaryFile,
            SELECTION_FILE: CFG.selectionFile,
            /* eslint-enable @typescript-eslint/naming-convention */
        },
    });
}

function getWorkspaceFoldersAsString() {
    // For bash invocation. Need to wrap in quotes so spaces within paths don't
    // split the path into two strings.
    return CFG.folders.reduce((x, y) => x + ` '${y}'`, '');
}

function getCommandString(cmd: Command, withArgs: boolean = true, withTextSelection: boolean = true) {
    assert(cmd.uri);
    let ret = '';
    const cmdPath = cmd.uri.fsPath;
    if (CFG.useEditorSelectionAsQuery && withTextSelection) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const selection = editor.selection;
            if (!selection.isEmpty) {
                //
                // Fun story on text selection:
                // My first idea was to use an env var to capture the selection.
                // My first test was to use a selection that contained shell script...
                // This breaks. And fixing it is not easy. See https://unix.stackexchange.com/a/600214/128132.
                // So perhaps we should write this to file, and see if we can get bash to interpret this as a
                // string. We'll use an env var to indicate there is a selection so we don't need to read a
                // file in the general no-selection case, and we don't have to clear the file after having
                // used the selection.
                //
                const selectionText = editor.document.getText(selection);
                fs.writeFileSync(CFG.selectionFile, selectionText);
                ret += 'HAS_SELECTION=1 ';
            }
        }
    }
    ret += cmdPath;
    if (withArgs) {
        let paths = getWorkspaceFoldersAsString();
        if (CFG.folders.length === 0) {  // no workspace folders
            paths = CFG.defaultSearchLocation;
        }
        ret += ` ${paths}`;
    }
    return ret;
}

function getIgnoreGlobs() {
    const exclude = vscode.workspace.getConfiguration('search.exclude');  // doesn't work though the docs say it should?
    const globs: string[] = [];
    Object.entries(exclude).forEach(([k, v]) => {
        // Messy proxy object stuff
        if (typeof v === 'function') { return; }
        if (v) { globs.push(`!${k}`); }
    });
    return globs;
}

function getIgnoreString() {
    const globs = getIgnoreGlobs();
    // We separate by colons so we can have spaces in the globs
    return globs.reduce((x, y) => x + `${y}:`, '');
}

function executeTerminalCommand(cmd: string) {
    getIgnoreGlobs();
    if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
        if (!reinitialize()) {
            return;
        }
    }

    if (!term || term.exitStatus !== undefined) {
        createTerminal();
        term.sendText('PS1="::: Terminal allocated for FindItFaster. Do not use. ::: " bash');
    }

    assert(cmd in commands);
    term.sendText(getCommandString(commands[cmd]));
    if (CFG.showMaximizedTerminal) {
        vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    }
    term.show();
}
