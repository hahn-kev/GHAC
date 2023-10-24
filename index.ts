import { parse } from "yaml";
import { readdir, readFile } from 'node:fs/promises';
import path from 'path';

interface Workflow {
    on: Record<string, unknown>,
    jobs: Record<string, Job>
}

interface Job {
    needs?: string | string[];
    uses?: string;
    if?: string;
}


async function loadFiles(location: string) {
    const fileMap: Record<string, Workflow> = {};
    let workflowFolder = location;
    let files = await readdir(workflowFolder);
    if (files.includes('.github')) {
        workflowFolder = path.join(workflowFolder, '.github', 'workflows');
        files = await readdir(workflowFolder);
    }
    for (const fileName of files) {
        if (fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
            fileMap[fileName] = parse(await readFile(path.join(workflowFolder, fileName), 'utf-8'));
    }
    return fileMap;
}

async function loadGh(location: string) {
    const fileMap: Record<string, Workflow> = {};
    const url = location;
    const result = url.match(/https:\/\/github\.com\/(.*)\/(.*)/);
    if (result === null) throw new Error('Invalid GitHub URL');
    const orgName = result[1];
    const repoName = result[2];
    let main: any;
    let branchNames = ['main', 'master'];
    for (const branch of branchNames) {
        main = await (await fetch(`https://api.github.com/repos/${orgName}/${repoName}/git/trees/${branch}`)).json();
        if (main.tree !== undefined) break;
    }
    if (main.tree === undefined) throw new Error('Could not find main branch');
    const github = await (await fetch(main.tree.filter(f => f.path == '.github').at(0).url)).json();
    const workflows = await (await fetch(github.tree.filter(f => f.path == 'workflows').at(0).url)).json();
    for (const file of workflows.tree) {
        const workflow = await (await fetch(file.url)).json();
        fileMap[file.path] = parse(atob(workflow.content));
    }
    return fileMap;
}
let fileMap: Record<string, Workflow>
const location = process.argv[2];
if (location.startsWith('http')) {
    fileMap = await loadGh(location);
} else {
    fileMap = await loadFiles(location);
}
const mermaidTemplate = `
flowchart LR
%% declarations
    ${declarations(fileMap)}
%% links
    ${links(fileMap)}
`;

function declarations(files: Record<string, Workflow>) {
    return Object.entries(files).map(([fileName, file]) => {
        const jobNames = getLinkNames(fileName, file, true);
        const triggerNames = getTriggerNames(fileName, file, true);
        return `
subgraph ${fileName}
    ${jobNames.concat(triggerNames).join('\n    ')}
end` ;
    }).join('\n    ');
}

function links(files: Record<string, Workflow>) {
    return Object.entries(files).flatMap(([filename, file]) => {
        const triggerNames = getTriggerNames(filename, file);
        return Object.entries(file.jobs)
            .flatMap(([jobName, job]) => getNeedBasedLinks(filename, job, jobName, triggerNames)
                .concat(getWorkflowCalls(filename, job, jobName)))
            .join('\n    ');
    }).join('\n    ');
}

function getNeedBasedLinks(filename: string, job: Job, jobName: string, triggerNames: string[]) {
    let condition = job.if ?? '';
    if (condition) {
        condition = `|"${condition.replace(/\$\{\{|\}\}/g, '')}"|`;
    }
    jobName = getJobName(filename, jobName);
    if (job.needs === undefined) {
        return triggerNames.map(triggerName => `${triggerName} -->${condition} ${jobName}`);
    }
    let needs = job.needs;
    if (typeof needs === 'string') {
        needs = [needs];
    }
    return needs.map((need: string) => `${getJobName(filename, need)} -->${condition} ${jobName}`);
}

function getWorkflowCalls(filename: string, job: Job, jobName: string) {
    if (job.uses === undefined) return [];
    let calledFile = path.basename(job.uses);
    return [`${getJobName(filename, jobName)} ---> ${getJobName(calledFile, 'workflow_call')}`];
}

function getTriggerNames(fileName: string, file: Workflow, title: boolean = false) {
    const triggerNames = Object.keys(file.on);
    return triggerNames.map(triggerName => `${fileName}.${triggerName}${title ? `{${triggerName}}` : ''}`);
}
function getJobName(filename: string, jobName: string) {
    return `${filename}.${jobName}`;
}
function getLinkNames(fileName: string, file: Workflow, title: boolean = false) {
    const jobs = Object.keys(file.jobs);
    return jobs.map(jobName => `${getJobName(fileName, jobName)}${title ? `[${jobName}]` : ''}`);
}

const md = `
${'```mermaid'}
${mermaidTemplate}
${'```'}`;
Bun.write('./action-examples/mermaid.md', md);