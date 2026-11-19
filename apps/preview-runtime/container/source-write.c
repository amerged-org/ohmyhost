#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* These checks avoid ordinary unsafe path mutations. The entire VM, including
 * this helper and its parent directories, remains untrusted customer state. */
static int reserved(const char *part) {
  const char *names[] = {"node_modules", ".next", ".astro", ".wrangler", ".vite", ".tanstack", ".git", NULL};
  if (!*part || !strcmp(part, ".") || !strcmp(part, "..") || !strncmp(part, ".ohmyhost-preview-", sizeof(".ohmyhost-preview-") - 1)) return 1;
  for (int i = 0; names[i]; i++) if (!strcmp(part, names[i])) return 1;
  for (const unsigned char *p = (const unsigned char *)part; *p; p++) if (*p == '\\' || *p < 32 || *p == 127) return 1;
  return strlen(part) > NAME_MAX;
}

static int parent_for(int root, char *path, int create, char **leaf, dev_t device) {
  char *save = NULL;
  char *part = strtok_r(path, "/", &save);
  int parent = dup(root);
  if (!part || parent < 0) return -1;
  while (part) {
    if (reserved(part)) { close(parent); return -1; }
    char *next_part = strtok_r(NULL, "/", &save);
    if (!next_part) { *leaf = part; return parent; }
    int next = openat(parent, part, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 && errno == ENOENT && create) {
      if (mkdirat(parent, part, 0755) && errno != EEXIST) { close(parent); return -1; }
      next = openat(parent, part, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next >= 0 && fchownat(parent, part, 10001, 10001, AT_SYMLINK_NOFOLLOW)) { close(next); close(parent); return -1; }
    }
    if (next < 0) { close(parent); return -1; }
    struct stat st;
    if (fstat(next, &st) || !S_ISDIR(st.st_mode) || st.st_dev != device) { close(next); close(parent); return -1; }
    close(parent);
    parent = next;
    part = next_part;
  }
  close(parent);
  return -1;
}

/* Cache roots are runtime-created and excluded from source deltas. */
static int prepare_caches(int root, const char *relative, dev_t device) {
  int dir = dup(root);
  if (dir < 0) return -1;
  if (strcmp(relative, ".")) {
    if (!*relative || *relative == '/' || strstr(relative, "//") || relative[strlen(relative) - 1] == '/') return -1;
    char *copy = strdup(relative), *save = NULL;
    if (!copy) return -1;
    for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
      if (reserved(part)) { free(copy); close(dir); return -1; }
      int next = openat(dir, part, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      struct stat st;
      if (next < 0 || fstat(next, &st) || !S_ISDIR(st.st_mode) || st.st_dev != device) { if (next >= 0) close(next); free(copy); close(dir); return -1; }
      close(dir); dir = next;
    }
    free(copy);
  }
  const char *names[] = {"node_modules", ".next", ".astro", ".wrangler", ".vite", ".tanstack", NULL};
  for (int i = 0; names[i]; i++) {
    if (mkdirat(dir, names[i], 0755) && errno != EEXIST) { close(dir); return -1; }
    struct stat st;
    if (fstatat(dir, names[i], &st, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(st.st_mode) || st.st_dev != device || fchownat(dir, names[i], 10001, 10001, AT_SYMLINK_NOFOLLOW)) { close(dir); return -1; }
  }
  close(dir);
  return 0;
}

/* Removed source directories may be needed as files in the next snapshot. Only
 * empty, same-device directories are removed, and never the workspace root. */
static void prune_empty_parents(int root, const char *original, dev_t device) {
  char *path = strdup(original);
  if (!path) return;
  char *slash;
  while ((slash = strrchr(path, '/')) != NULL) {
    *slash = 0;
    char *copy = strdup(path), *leaf = NULL;
    if (!copy) break;
    int parent = parent_for(root, copy, 0, &leaf, device);
    if (parent < 0) { free(copy); break; }
    struct stat st;
    int result = fstatat(parent, leaf, &st, AT_SYMLINK_NOFOLLOW);
    if (!result && S_ISDIR(st.st_mode) && st.st_dev == device) result = unlinkat(parent, leaf, AT_REMOVEDIR);
    else result = -1;
    close(parent); free(copy);
    if (result) break;
  }
  free(path);
}

int main(int argc, char **argv) {
  if (argc < 3 || (strcmp(argv[1], "write") && strcmp(argv[1], "delete") && strcmp(argv[1], "prepare-caches")) || (!strcmp(argv[1], "write") ? (argc != 4 || (strcmp(argv[3], "0") && strcmp(argv[3], "1"))) : argc != 3) || !*argv[2] || strlen(argv[2]) > 4096 || argv[2][0] == '/' || strstr(argv[2], "//") || argv[2][strlen(argv[2]) - 1] == '/') return 2;
  int root = open("/workspace/app", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat root_stat;
  if (root < 0 || fstat(root, &root_stat)) return 3;
  if (!strcmp(argv[1], "prepare-caches")) return prepare_caches(root, argv[2], root_stat.st_dev) ? 4 : 0;
  int staging = open("/workspace/runtime/source-write", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat staging_stat;
  if (staging < 0 || fstat(staging, &staging_stat) || staging_stat.st_dev != root_stat.st_dev || staging_stat.st_uid != 0 || (staging_stat.st_mode & 077) != 0) return 3;
  char *path = strdup(argv[2]);
  if (!path) return 3;
  char *leaf = NULL;
  int writing = !strcmp(argv[1], "write");
  int parent = parent_for(root, path, writing, &leaf, root_stat.st_dev);
  if (parent < 0) { free(path); close(root); return 4; }
  struct stat old;
  if (!fstatat(parent, leaf, &old, AT_SYMLINK_NOFOLLOW)) {
    if (old.st_dev != root_stat.st_dev) return 5;
    if (writing && S_ISDIR(old.st_mode)) {
      if (unlinkat(parent, leaf, AT_REMOVEDIR)) return 5;
    } else if (!S_ISREG(old.st_mode) || old.st_nlink != 1) return 5;
  } else if (errno != ENOENT) return 5;
  if (!writing) {
    if (unlinkat(parent, leaf, 0) && errno != ENOENT) return 6;
    prune_empty_parents(root, argv[2], root_stat.st_dev);
    close(parent); close(root); free(path);
    return 0;
  }
  char temporary[80];
  snprintf(temporary, sizeof(temporary), ".ohmyhost-preview-write-%ld", (long)getpid());
  int out = openat(staging, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (out < 0) return 7;
  char buffer[16384];
  ssize_t count;
  while ((count = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
    for (ssize_t offset = 0; offset < count;) {
      ssize_t written = write(out, buffer + offset, (size_t)(count - offset));
      if (written <= 0) { unlinkat(staging, temporary, 0); return 8; }
      offset += written;
    }
  }
  if (count < 0 || renameat(staging, temporary, parent, leaf)) { unlinkat(staging, temporary, 0); return 9; }
  if (fchown(out, 10001, 10001) || fchmod(out, !strcmp(argv[3], "1") ? 0755 : 0644) || close(out)) return 10;
  close(staging); close(parent); close(root); free(path);
  return 0;
}
