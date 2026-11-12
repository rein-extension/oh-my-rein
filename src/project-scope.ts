import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

// A working directory may be any real subdirectory of the bound checkout.
// Symlinks cannot escape that boundary; a nested repository/worktree has its
// own project identity and must use its own connection.
export function belongsToProject(cwd:string,project:string){
  try{
    const root=realpathSync(project),directory=realpathSync(cwd),part=relative(root,directory);
    if(isAbsolute(part)||part==='..'||part.startsWith('../'))return false;
    for(let current=directory;current!==root;current=dirname(current))if(existsSync(join(current,'.git')))return false;
    return true;
  }catch{return false;}
}
export function assertProject(cwd:string,project:string){
  if(!belongsToProject(cwd,project))throw Error('Rein connection belongs to a different project');
}
