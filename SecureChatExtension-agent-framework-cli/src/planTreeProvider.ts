/**
 * Plan Tree Provider — renders the agent's plan steps in a native VS Code tree view panel.
 * Shows step status with icons (pending, in-progress, completed, failed).
 */
import * as vscode from 'vscode';
import { AgentPlanStep } from './types';

export class PlanTreeProvider implements vscode.TreeDataProvider<AgentPlanStep> {
    private steps: AgentPlanStep[] = [];
    private treeView?: vscode.TreeView<AgentPlanStep>;
    private _onDidChangeTreeData = new vscode.EventEmitter<AgentPlanStep | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    setTreeView(view: vscode.TreeView<AgentPlanStep>) {
        this.treeView = view;
    }

    updatePlan(steps: AgentPlanStep[]) {
        this.steps = steps;
        this._onDidChangeTreeData.fire(undefined);
        // Show the current in-progress step as the panel description
        const current = steps.find(s => s.status === 'in_progress');
        if (this.treeView) {
            this.treeView.description = current ? current.title : '';
        }
    }

    clear() {
        this.steps = [];
        this._onDidChangeTreeData.fire(undefined);
        if (this.treeView) {
            this.treeView.description = '';
        }
    }

    getTreeItem(element: AgentPlanStep): vscode.TreeItem {
        const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
        item.id = element.id;

        switch (element.status) {
            case 'in_progress':
                item.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'));
                break;
            case 'completed':
                item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case 'failed':
                item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                break;
            default: // pending
                item.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
                break;
        }

        return item;
    }

    getChildren(): AgentPlanStep[] {
        return this.steps;
    }

    dispose() {
        this._onDidChangeTreeData.dispose();
    }
}
