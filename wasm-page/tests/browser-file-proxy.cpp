// Integration probe for Emscripten's synchronous pthread / asynchronous JS bridge.
// Build with the production BrowserFileLibrary.js and browser-files.js pre-js.
#include <pthread.h>
#include <stdio.h>
#include <errno.h>
#include <sys/stat.h>
#include <emscripten.h>

extern "C" {
double ppsspp_browser_file_size(const char *path);
int ppsspp_browser_has_files();
int ppsspp_browser_read(const char *path, double offset, int bytes, void *destination);
}

static void *ReadGame(void *) {
	const char *path = "/browser-games/probe.iso";
	unsigned char result[8]{};
	const int count = ppsspp_browser_read(path, 4, sizeof(result), result);
	const bool ok = ppsspp_browser_has_files() == 1 && ppsspp_browser_file_size(path) == 16
		&& count == 8 && result[0] == 4 && result[7] == 11;
	printf("Browser file pthread probe: count=%d first=%d last=%d\n", count, result[0], result[7]);
	emscripten_force_exit(ok ? 0 : 1);
	return nullptr;
}

int main() {
	EM_ASM({
		globalThis.PpssppBrowserFiles.register('/browser-games/probe.iso',
			new Blob([Uint8Array.from({ length: 16 }, (_, i) => i)]));
		globalThis.PpssppBrowserFiles.mirror(FS, '/browser-games/probe.iso');
	});
	struct stat info{};
	if (stat("/browser-games/probe.iso", &info) != 0 || info.st_size != 16) return 1;
	FILE *mirror = fopen("/browser-games/probe.iso", "rb");
	if (!mirror) return 1;
	errno = 0;
	if (fgetc(mirror) != EOF || errno != EIO) return 1;
	fclose(mirror);
	pthread_t thread;
	if (pthread_create(&thread, nullptr, ReadGame, nullptr) != 0) return 1;
	// Keep Node alive while its preloaded worker services the request. A browser
	// naturally keeps its page alive, but Node otherwise unrefs the worker pool.
	emscripten_set_main_loop([]() {}, 1, true);
}
