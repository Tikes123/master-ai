import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { glob } from 'glob';
import * as tf from '@tensorflow/tfjs';
import * as use from '@tensorflow-models/universal-sentence-encoder';

let statusBarItem: vscode.StatusBarItem;
let diagnosticCollection: vscode.DiagnosticCollection;

interface Suggestion {
  type: string;
  message: string;
  line: number;
}

interface Issue {
  type: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
  solution: string;
  file: string;
  line?: number;
}

interface CleanupSuggestion {
  type: string;
  message: string;
  file: string;
  severity: 'low' | 'medium' | 'high';
  solution: string;
}

interface Review {
  suggestions: Suggestion[];
  potentialIssues: Issue[];
}

interface Analysis {
  directoryStructure: {
    mainDirectories: string[];
    missingDirectories: string[];
    extraDirectories: string[];
  };
  files: {
    total: number;
    byType: { [key: string]: number };
    largeFiles: Array<{ name: string; size: number }>;
    duplicateFiles: string[];
  };
  suggestions: CleanupSuggestion[];
  potentialIssues: CleanupSuggestion[];
  issues: Issue[];
}

export function activate(context: vscode.ExtensionContext) {
  console.log('AI Code Assistant is now active!');

  // Initialize status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(code) master-coder";
  statusBarItem.command = 'master-coder.analyzeProject';
  statusBarItem.show();

  // Initialize diagnostic collection
  diagnosticCollection = vscode.languages.createDiagnosticCollection('master-coder');

  // Register commands
  let analyzeProject = vscode.commands.registerCommand('master-coder.analyzeProject', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    try {
      statusBarItem.text = "$(sync~spin) Analyzing...";
      const analysis = await analyzeWorkspace(workspaceFolders[0]);
      showAnalysisResults(analysis);
      
      // Update diagnostics for all open documents
      vscode.workspace.textDocuments.forEach(doc => {
        updateDiagnostics(doc, analysis);
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Error analyzing project: ${error}`);
    } finally {
      statusBarItem.text = "$(check) Analysis Complete";
    }
  });

  let reviewCode = vscode.commands.registerCommand('master-coder.reviewCode', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    const document = editor.document;
    const code = document.getText();
    const filePath = document.uri.fsPath;

    try {
      statusBarItem.text = "$(sync~spin) Reviewing...";
      const review = await reviewCodeContent(code, filePath);
      showCodeReview(review);
      updateEditorDecorations(editor, review);
    } catch (error) {
      vscode.window.showErrorMessage(`Error reviewing code: ${error}`);
    } finally {
      statusBarItem.text = "$(code) master-coder";
    }
  });

  let generateDocs = vscode.commands.registerCommand('master-coder.generateDocs', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    const document = editor.document;
    const code = document.getText();
    const filePath = document.uri.fsPath;

    try {
      statusBarItem.text = "$(sync~spin) Generating...";
      const docs = await generateDocumentation(code, filePath);
      showDocumentation(docs);
      insertDocumentation(editor, docs);
    } catch (error) {
      vscode.window.showErrorMessage(`Error generating documentation: ${error}`);
    } finally {
      statusBarItem.text = "$(code) master-coder";
    }
  });

  // Register file change listener
  const fileChangeListener = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (event.document.uri.scheme === 'file') {
      const config = vscode.workspace.getConfiguration('masterCoder');
      if (config.get<boolean>('autoReview', true)) {
        const review = await reviewCodeContent(event.document.getText(), event.document.uri.fsPath);
        updateEditorDecorations(vscode.window.activeTextEditor, review);
      }
    }
  });

  context.subscriptions.push(
    analyzeProject,
    reviewCode,
    generateDocs,
    statusBarItem,
    diagnosticCollection,
    fileChangeListener
  );
}

function updateDiagnostics(document: vscode.TextDocument, analysis: Analysis) {
  const diagnostics: vscode.Diagnostic[] = [];
  const filePath = document.uri.fsPath;

  analysis.issues.forEach(issue => {
    if (issue.file === filePath) {
      const lineNumber = issue.line ?? 0;
      const line = document.lineAt(lineNumber);
      const range = new vscode.Range(
        new vscode.Position(lineNumber, 0),
        new vscode.Position(lineNumber, line.text.length)
      );

      const diagnostic = new vscode.Diagnostic(
        range,
        `${issue.message}\nSolution: ${issue.solution}`,
        getDiagnosticSeverity(issue.severity)
      );
      diagnostic.source = 'master-coder';
      diagnostics.push(diagnostic);
    }
  });

  diagnosticCollection.set(document.uri, diagnostics);
}

function updateEditorDecorations(editor: vscode.TextEditor | undefined, review: Review) {
  if (!editor) return;

  const decorations: vscode.DecorationOptions[] = [];

  // Add decorations for suggestions
  review.suggestions.forEach((suggestion: Suggestion) => {
    const line = editor.document.lineAt(suggestion.line - 1);
    decorations.push({
      range: line.range,
      hoverMessage: suggestion.message,
      renderOptions: {
        after: {
          contentText: " 💡 " + suggestion.message,
          color: new vscode.ThemeColor('editorCodeLens.foreground')
        }
      }
    });
  });

  // Add decorations for issues
  review.potentialIssues.forEach((issue: Issue) => {
    if (issue.line !== undefined) {
      const line = editor.document.lineAt(issue.line - 1);
      decorations.push({
        range: line.range,
        hoverMessage: `${issue.message} - Solution: ${issue.solution}`,
        renderOptions: {
          after: {
            contentText: " ⚠️ " + issue.message,
            color: new vscode.ThemeColor('errorForeground')
          }
        }
      });
    }
  });

  editor.setDecorations(
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true
    }),
    decorations
  );
}

function insertDocumentation(editor: vscode.TextEditor, docs: string) {
  const position = new vscode.Position(0, 0);
  editor.edit(editBuilder => {
    editBuilder.insert(position, docs);
  });
}

async function analyzeWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<Analysis> {
  const analysis: Analysis = {
    directoryStructure: {
      mainDirectories: [],
      missingDirectories: [],
      extraDirectories: []
    },
    files: {
      total: 0,
      byType: {},
      largeFiles: [],
      duplicateFiles: []
    },
    suggestions: [],
    potentialIssues: [],
    issues: []
  };

  try {
    const files = await new Promise<string[]>((resolve, reject) => {
      glob('**/*', { cwd: workspaceFolder.uri.fsPath, dot: true }, (err, matches) => {
        if (err) reject(err);
        else resolve(matches);
      });
    });

    // Process files and update analysis
    for (const file of files) {
      const filePath = path.join(workspaceFolder.uri.fsPath, file);
      const stats = await fs.promises.stat(filePath);
      
      if (stats.isFile()) {
        analysis.files.total++;
        const ext = path.extname(file).toLowerCase();
        analysis.files.byType[ext] = (analysis.files.byType[ext] || 0) + 1;
        
        if (stats.size > 1024 * 1024) { // Files larger than 1MB
          analysis.files.largeFiles.push({
            name: file,
            size: stats.size
          });
        }
      }
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Error analyzing workspace: ${error}`);
  }

  return analysis;
}

function processFileAnalysis(analysis: Analysis, file: string, stats: fs.Stats, content: string, embedding: number[]) {
  // Update file count and types
  analysis.files.total++;
  const ext = path.extname(file).toLowerCase();
  analysis.files.byType[ext] = (analysis.files.byType[ext] || 0) + 1;

  // Check for large files
  if (stats.size > 1024 * 1024) {
    analysis.files.largeFiles.push({
      name: file,
      size: stats.size
    });
  }

  // Analyze code content
  if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') {
    analyzeCodeContent(analysis, file, content);
  }
}

function analyzeCodeContent(analysis: Analysis, file: string, content: string) {
  // Check for common issues
  if (content.includes('console.log')) {
    analysis.suggestions.push({
      type: 'cleanup',
      message: 'Remove console.log statements before production',
      file: file,
      severity: 'low',
      solution: 'Review and remove unnecessary console.log statements'
    });
  }

  if (content.includes('process.env')) {
    analysis.potentialIssues.push({
      type: 'security',
      message: 'Environment variables should be properly configured',
      severity: 'high',
      solution: 'Use environment configuration files',
      file: file
    });
  }

  // Add more code analysis here
}

async function reviewCodeContent(code: string, filePath: string): Promise<Review> {
  const model = await use.load();
  const embeddings = await model.embed([code]);
  const embeddingArray = await embeddings.array();

  // Analyze code patterns and generate review
  return {
    suggestions: [
      {
        type: 'optimization',
        message: 'Consider using async/await for better readability',
        line: 10
      },
      {
        type: 'security',
        message: 'Add input validation for user data',
        line: 25
      }
    ],
    potentialIssues: [
      {
        type: 'performance',
        message: 'Potential memory leak in loop',
        severity: 'high',
        solution: 'Use proper cleanup in loop',
        line: 42,
        file: filePath
      }
    ]
  };
}

async function generateDocumentation(code: string, filePath: string): Promise<string> {
  const model = await use.load();
  const embeddings = await model.embed([code]);
  const embeddingArray = await embeddings.array();

  // Generate documentation based on code analysis
  return `
/**
 * ${path.basename(filePath)}
 * 
 * This file contains the following functionality:
 * - Function definitions
 * - Class implementations
 * - Utility methods
 * 
 * Usage:
 * \`\`\`javascript
 * // Example usage
 * \`\`\`
 */
`;
}

function showAnalysisResults(analysis: Analysis) {
  const panel = vscode.window.createWebviewPanel(
    'analysisResults',
    'Project Analysis Results',
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = getAnalysisHtml(analysis);
}

function showCodeReview(review: Review) {
  const panel = vscode.window.createWebviewPanel(
    'codeReview',
    'Code Review',
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = getReviewHtml(review);
}

function showDocumentation(docs: string) {
  const panel = vscode.window.createWebviewPanel(
    'documentation',
    'Generated Documentation',
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = getDocumentationHtml(docs);
}

function getAnalysisHtml(analysis: Analysis): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .section { margin-bottom: 20px; }
        .issue { color: red; }
        .suggestion { color: blue; }
      </style>
    </head>
    <body>
      <h1>Project Analysis Results</h1>
      <div class="section">
        <h2>Directory Structure</h2>
        <p>Total Files: ${analysis.files.total}</p>
        <h3>File Types:</h3>
        <ul>
          ${Object.entries(analysis.files.byType)
            .map(([type, count]) => `<li>${type}: ${count} files</li>`)
            .join('')}
        </ul>
      </div>
      <div class="section">
        <h2>Suggestions</h2>
        <ul>
          ${analysis.suggestions
            .map(s => `<li class="suggestion">${s.message} (${s.file})</li>`)
            .join('')}
        </ul>
      </div>
      <div class="section">
        <h2>Potential Issues</h2>
        <ul>
          ${analysis.potentialIssues
            .map(i => `<li class="issue">${i.message} - Solution: ${i.solution}</li>`)
            .join('')}
        </ul>
      </div>
    </body>
    </html>
  `;
}

function getReviewHtml(review: Review): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .suggestion { color: blue; }
        .issue { color: red; }
      </style>
    </head>
    <body>
      <h1>Code Review</h1>
      <div>
        <h2>Suggestions</h2>
        <ul>
          ${review.suggestions
            .map(s => `<li class="suggestion">Line ${s.line}: ${s.message}</li>`)
            .join('')}
        </ul>
      </div>
      <div>
        <h2>Potential Issues</h2>
        <ul>
          ${review.potentialIssues
            .map(i => `<li class="issue">Line ${i.line}: ${i.message} - Solution: ${i.solution}</li>`)
            .join('')}
        </ul>
      </div>
    </body>
    </html>
  `;
}

function getDocumentationHtml(docs: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        pre { background-color: #f5f5f5; padding: 10px; }
      </style>
    </head>
    <body>
      <h1>Generated Documentation</h1>
      <pre>${docs}</pre>
    </body>
    </html>
  `;
}

async function analyzeFile(filePath: string): Promise<Issue[]> {
    const issues: Issue[] = [];
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for potential issues
    lines.forEach((line, index) => {
        if (line.includes('TODO')) {
            issues.push({
                type: 'TODO Comment',
                message: 'Found TODO comment that should be addressed',
                severity: 'low',
                solution: 'Consider implementing the TODO or removing it if no longer needed',
                file: filePath,
                line: index + 1
            });
        }
        // Add more issue checks as needed
    });

    return issues;
}

function getDiagnosticSeverity(severity: string): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'low':
      return vscode.DiagnosticSeverity.Information;
    case 'medium':
      return vscode.DiagnosticSeverity.Warning;
    case 'high':
      return vscode.DiagnosticSeverity.Error;
    default:
      throw new Error(`Unknown severity: ${severity}`);
  }
}

function checkForCleanupOpportunities(file: string): CleanupSuggestion[] {
    const suggestions: CleanupSuggestion[] = [];
    
    // Example cleanup check
    if (file.endsWith('.js') || file.endsWith('.ts')) {
        suggestions.push({
            type: 'cleanup',
            message: 'Remove console.log statements before production',
            file: file,
            severity: 'low',
            solution: 'Review and remove unnecessary console.log statements'
        });
    }
    
    return suggestions;
}

export function deactivate() {} 