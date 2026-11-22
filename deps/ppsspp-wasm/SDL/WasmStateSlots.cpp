// SPDX-License-Identifier: GPL-2.0-or-later
#include <algorithm>
#include <emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>

#include "Common/File/FileUtil.h"
#include "Common/System/System.h"
#include "Core/Config.h"
#include "Core/HLE/sceNet.h"
#include "Core/RetroAchievements.h"
#include "Core/SaveState.h"
#include "Core/System.h"

namespace {
enum class SlotAction { Inspect, SaveEmpty, Replace, Load, InspectMenu };

void Reply(int id, const std::string &path, int slot, int count, const std::string &error = {}, const std::string &warning = {}) {
	// SaveSlot and LoadSlot finish on the emulation thread. Copy the strings
	// into the queued reply before returning from the core callback.
	static emscripten::ProxyingQueue replies;
	replies.proxyAsync(emscripten_main_runtime_thread_id(), [=]() {
		EM_ASM({
			Module['onWebStateSlot']($0, UTF8ToString($1), $2, $3, UTF8ToString($4), UTF8ToString($5));
		}, id, path.c_str(), slot, count, error.c_str(), warning.c_str());
	});
}
}

extern "C" EMSCRIPTEN_KEEPALIVE void ppssppWebOpenMenu() {
	System_PostUIMessage(UIMessage::REQUEST_GAME_PAUSE);
}

extern "C" EMSCRIPTEN_KEEPALIVE void ppssppWebStateSlot(int id, int action, int requestedSlot, const char *expectedPath) {
	System_RunOnMainThread([=, expected = std::string(expectedPath ? expectedPath : "")]() {
		const int count = g_Config.iSaveStateSlotCount;
		const auto op = static_cast<SlotAction>(action);
		if (op == SlotAction::InspectMenu) {
			Reply(id, {}, GetUIState() == UISTATE_PAUSEMENU ? 1 : 0, count);
			return;
		}
		const int slot = op == SlotAction::Inspect && (requestedSlot < 0 || requestedSlot >= count) ?
			std::clamp(SaveState::GetCurrentSlot(), 0, count - 1) : requestedSlot;
		if (!PSP_IsInited() || GetUIState() != UISTATE_INGAME || slot < 0 || slot >= count) {
			Reply(id, {}, slot, count, "unavailable");
			return;
		}
		const auto prefix = SaveState::GetGamePrefix(g_paramSFO);
		const Path file = SaveState::GenerateSaveSlotPath(prefix, slot, "ppst");
		const std::string path = file.ToString();
		if (op == SlotAction::Inspect) {
			Reply(id, path, slot, count);
			return;
		}
		if (path != expected || path.empty()) {
			Reply(id, path, slot, count, "changed");
			return;
		}
		if (!NetworkAllowSaveState() || (Achievements::HardcoreModeActive() &&
			(op == SlotAction::Load || !g_Config.bAchievementsSaveStateInHardcoreMode))) {
			Reply(id, path, slot, count, "restricted");
			return;
		}
		auto done = [=](SaveState::Status status, std::string_view message) {
			Reply(id, path, slot, count, status == SaveState::Status::FAILURE ? "failed" : "",
				status != SaveState::Status::SUCCESS ? std::string(message) : "");
		};
		switch (op) {
		case SlotAction::SaveEmpty:
			if (File::Exists(file)) {
				Reply(id, path, slot, count, "occupied");
				return;
			}
			[[fallthrough]];
		case SlotAction::Replace:
			g_Config.iCurrentStateSlot = slot;
			SaveState::SaveSlot(prefix, slot, done);
			break;
		case SlotAction::Load:
			if (!File::Exists(file)) {
				Reply(id, path, slot, count, "empty");
				return;
			}
			g_Config.iCurrentStateSlot = slot;
			SaveState::LoadSlot(prefix, slot, done);
			break;
		default:
			Reply(id, path, slot, count, "unavailable");
		}
	});
}
