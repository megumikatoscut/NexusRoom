package com.nexusroom.android;

import android.content.Context;
import android.content.Intent;
import android.provider.Settings;

/** Device-local navigation. No room broadcast or remote Agent event enters this path. */
final class VoiceWakeUi {
    static final String ACTION = "com.nexusroom.android.LOCAL_VOICE_WAKE";
    static final String MEMBER = "voice_member", EVENT = "voice_event";

    static boolean canOpenFromBackground(Context context) {
        return ControlService.instance != null || Settings.canDrawOverlays(context);
    }

    static Intent intent(Context context, String member, String event) {
        return new Intent(context, MainActivity.class).setAction(ACTION)
            .putExtra(MEMBER, member).putExtra(EVENT, event)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    static void open(Context context, String member, String event) {
        // Android permits launches from a system-bound accessibility service or
        // with the user's overlay grant. Neither changes remote-control consent.
        Context launcher = ControlService.instance == null ? context : ControlService.instance;
        launcher.startActivity(intent(context, member, event));
    }
}
