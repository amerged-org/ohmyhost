#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Resolve each component relative to an already-open directory without following symlinks.
 * This also works in local emulation, where openat2 is unavailable. */
static int open_parent(int root, char *path) {
  int dir = dup(root);
  if (dir < 0) return -1;
  char *save = NULL;
  for (char *part = strtok_r(path, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    int next = openat(dir, part, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(dir);
    if (next < 0) return -1;
    dir = next;
  }
  return dir;
}

int main(int argc, char **argv) {
  if (argc != 2 || strncmp(argv[1], "src/", 4) || strstr(argv[1], "..")) return 2;
  char *path = strdup(argv[1]);
  char *slash = strrchr(path, '/');
  if (!slash || !slash[1]) return 2;
  *slash++ = 0;
  int parent = open("/workspace", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) { perror("workspace_open"); return 3; }
  int root = openat(parent, "app", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) { perror("fixture_root_open"); return 3; }
  int dir = open_parent(root, path);
  if (dir < 0) { perror("source_parent_open"); return 3; }
  struct stat old;
  if (fstatat(dir, slash, &old, AT_SYMLINK_NOFOLLOW) || !S_ISREG(old.st_mode)) return 4;
  char temp[80];
  snprintf(temp, sizeof(temp), ".spike-edit-%ld", (long)getpid());
  int out = openat(dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644);
  if (out < 0) return 5;
  char buf[16384];
  ssize_t n;
  while ((n = read(STDIN_FILENO, buf, sizeof(buf))) > 0) {
    for (ssize_t offset = 0; offset < n;) {
      ssize_t written = write(out, buf + offset, (size_t)(n - offset));
      if (written <= 0) { unlinkat(dir, temp, 0); return 6; }
      offset += written;
    }
  }
  if (n < 0 || close(out) || renameat(dir, temp, dir, slash)) {
    unlinkat(dir, temp, 0); return 7;
  }
  close(dir); close(root); close(parent); free(path);
  return 0;
}
