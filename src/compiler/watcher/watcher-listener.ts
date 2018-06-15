import * as d from '../../declarations';
import { COMPONENTS_DTS } from '../distribution/distribution';
import { isCopyTaskFile } from '../copy/copy-tasks';
import { isDtsFile, isWebDevFile, normalizePath } from '../util';
import { rebuild } from './rebuild';


export class WatcherListener {
  private dirsAdded: string[];
  private dirsDeleted: string[];
  private filesAdded: string[];
  private filesDeleted: string[];
  private filesUpdated: string[];
  private configUpdated = false;
  private hasCopyChanges = false;
  private watchTmr: number;

  constructor(private config: d.Config, private compilerCtx: d.CompilerCtx) {
    this.resetWatcher();
  }

  subscribe() {
    this.compilerCtx.events.subscribe('fileUpdate', this.fileUpdate.bind(this));
    this.compilerCtx.events.subscribe('fileAdd', this.fileAdd.bind(this));
    this.compilerCtx.events.subscribe('fileDelete', this.fileDelete.bind(this));
    this.compilerCtx.events.subscribe('dirAdd', this.dirAdd.bind(this));
    this.compilerCtx.events.subscribe('dirDelete', this.dirDelete.bind(this));
  }

  async fileUpdate(filePath: string) {
    try {
      filePath = normalizePath(filePath);
      const relPath = this.config.sys.path.relative(this.config.rootDir, filePath);

      if (isComponentsDtsFile(filePath)) {
        return;
      }

      if (filePath === this.config.configPath) {
        this.config.logger.debug(`watcher, fileUpdate, config: ${relPath}, ${Date.now().toString().substring(5)}`);
        // the actual stencil config file changed
        // this is a big deal, so do a full rebuild
        this.configUpdated = true;

        if (!this.filesUpdated.includes(filePath)) {
          this.filesUpdated.push(filePath);
        }
        this.queue();

      } else if (isCopyTaskFile(this.config, filePath)) {
        this.config.logger.debug(`watcher, fileUpdate, copy task file: ${relPath}, ${Date.now().toString().substring(5)}`);
        this.hasCopyChanges = true;

        if (!this.filesUpdated.includes(filePath)) {
          this.filesUpdated.push(filePath);
        }
        this.queue();
      }

      if (isWebDevFileToWatch(filePath)) {
        // check if the file changed with a read the file, but without using
        // the cache so we know if it actually changed or not
        const hasChanged = await this.compilerCtx.fs.hasFileChanged(filePath);
        if (!hasChanged) {
          this.config.logger.debug(`watcher, fileUpdate, file unchanged: ${relPath}, ${Date.now().toString().substring(5)}`);
          return;
        }

        this.config.logger.debug(`watcher, fileUpdate: ${relPath}, ${Date.now().toString().substring(5)}`);

        // web dev file was updaed
        // queue change build
        if (!this.filesUpdated.includes(filePath)) {
          this.filesUpdated.push(filePath);
        }
        this.queue();

      } else {
        // always clear the cache if it wasn't a web dev file
        this.compilerCtx.fs.clearFileCache(filePath);
        this.config.logger.debug(`clear file cache: ${filePath}`);
      }

    } catch (e) {
      this.config.logger.error(`watcher, fileUpdate`, e);
    }
  }

  async fileAdd(filePath: string) {
    try {
      filePath = normalizePath(filePath);
      const relPath = this.config.sys.path.relative(this.config.rootDir, filePath);

      if (isComponentsDtsFile(filePath)) {
        return;
      }

      this.config.logger.debug(`watcher, fileAdd: ${relPath}, ${Date.now().toString().substring(5)}`);

      if (isCopyTaskFile(this.config, filePath)) {
        if (!this.filesAdded.includes(filePath)) {
          this.filesAdded.push(filePath);
        }
        this.hasCopyChanges = true;
        this.queue();
      }

      if (isWebDevFileToWatch(filePath)) {
        // read the file, but without using
        // the cache so we get the latest change
        await this.compilerCtx.fs.readFile(filePath, { useCache: false });

        // new web dev file was added
        if (!this.filesAdded.includes(filePath)) {
          this.filesAdded.push(filePath);
        }
        this.queue();

      } else {
        // always clear the cache if it wasn't a web dev file
        this.compilerCtx.fs.clearFileCache(filePath);
        this.config.logger.debug(`clear file cache: ${filePath}`);
      }

    } catch (e) {
      this.config.logger.error(`watcher, fileAdd`, e);
    }
  }

  fileDelete(filePath: string) {
    try {
      filePath = normalizePath(filePath);
      const relPath = this.config.sys.path.relative(this.config.rootDir, filePath);

      if (isComponentsDtsFile(filePath)) {
        return;
      }

      this.config.logger.debug(`watcher, fileDelete: ${relPath}, ${Date.now().toString().substring(5)}`);

      // clear this file's cache
      this.compilerCtx.fs.clearFileCache(filePath);

      if (isCopyTaskFile(this.config, filePath)) {
        if (!this.filesDeleted.includes(filePath)) {
          this.filesDeleted.push(filePath);
        }
        this.hasCopyChanges = true;
        this.queue();
      }

      if (isWebDevFileToWatch(filePath)) {
        // web dev file was delete
        if (!this.filesDeleted.includes(filePath)) {
          this.filesDeleted.push(filePath);
        }
        this.queue();
      }

    } catch (e) {
      this.config.logger.error(`watcher, fileDelete`, e);
    }
  }

  async dirAdd(dirPath: string) {
    try {
      dirPath = normalizePath(dirPath);
      const relPath = this.config.sys.path.relative(this.config.rootDir, dirPath);

      this.config.logger.debug(`watcher, dirAdd: ${relPath}, ${Date.now().toString().substring(5)}`);

      // clear this directory's cache for good measure
      this.compilerCtx.fs.clearDirCache(dirPath);

      // recursively drill down and get all of the
      // files paths that were just added
      const addedItems = await this.compilerCtx.fs.readdir(dirPath, { recursive: true });

      addedItems.forEach(item => {
        if (!this.filesAdded.includes(item.absPath)) {
          this.filesAdded.push(item.absPath);
        }
      });
      this.dirsAdded.push(dirPath);

      if (isCopyTaskFile(this.config, dirPath)) {
        this.hasCopyChanges = true;
      }

      this.queue();

    } catch (e) {
      this.config.logger.error(`watcher, dirAdd`, e);
    }
  }

  async dirDelete(dirPath: string) {
    try {
      dirPath = normalizePath(dirPath);
      const relPath = this.config.sys.path.relative(this.config.rootDir, dirPath);

      this.config.logger.debug(`watcher, dirDelete: ${relPath}, ${Date.now().toString().substring(5)}`);

      // clear this directory's cache
      this.compilerCtx.fs.clearDirCache(dirPath);

      if (!this.dirsDeleted.includes(dirPath)) {
        this.dirsDeleted.push(dirPath);
      }

      if (isCopyTaskFile(this.config, dirPath)) {
        this.hasCopyChanges = true;
      }

      this.queue();

    } catch (e) {
      this.config.logger.error(`watcher, dirDelete`, e);
    }
  }

  startRebuild() {
    try {
      // create a copy of all that we've learned today
      const watcher = this.generateWatcherResults();

      // reset the watcher data for next time
      this.resetWatcher();

      if (shouldRebuild(watcher)) {
        // kick off the rebuild
        rebuild(this.config, this.compilerCtx, watcher);
      }

    } catch (e) {
      this.config.logger.error(`watcher, startRebuild`, e);
    }
  }

  generateWatcherResults() {
    const watcher: d.WatcherResults = {
      dirsAdded: this.dirsAdded.slice(),
      dirsDeleted: this.dirsDeleted.slice(),
      filesAdded: this.filesAdded.slice(),
      filesDeleted: this.filesDeleted.slice(),
      filesUpdated: this.filesUpdated.slice(),
      configUpdated: this.configUpdated,
      hasCopyChanges: this.hasCopyChanges,
      filesChanged: [],
      changedExtensions: [],
      hasBuildChanges: false,
      hasScriptChanges: false,
      hasStyleChanges: false,
    };
    return watcher;
  }

  queue() {
    clearTimeout(this.watchTmr);

    this.watchTmr = setTimeout(this.startRebuild.bind(this), 20);
  }

  resetWatcher() {
    this.dirsAdded = [];
    this.dirsDeleted = [];
    this.filesAdded = [];
    this.filesDeleted = [];
    this.filesUpdated = [];
    this.configUpdated = false;
    this.hasCopyChanges = false;
  }

}


function shouldRebuild(watcher: d.WatcherResults) {
  return watcher.configUpdated ||
    watcher.hasCopyChanges ||
    watcher.dirsAdded.length > 0 ||
    watcher.dirsDeleted.length > 0 ||
    watcher.filesAdded.length > 0 ||
    watcher.filesDeleted.length > 0 ||
    watcher.filesUpdated.length > 0;
}


function isWebDevFileToWatch(filePath: string) {
  // ts, tsx, css, scss, js, html
  // but don't worry about jpg, png, gif, svgs
  // also don't bother rebuilds when the components.d.ts file gets updated
  return isWebDevFile(filePath) || (isDtsFile(filePath) && !isComponentsDtsFile(filePath));
}


function isComponentsDtsFile(filePath: string) {
  return filePath.endsWith(COMPONENTS_DTS);
}
