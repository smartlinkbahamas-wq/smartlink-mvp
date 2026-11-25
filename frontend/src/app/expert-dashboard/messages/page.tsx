"use client";

/**
 * Messaging is deliberately NOT implemented here yet.
 *
 * The previous version of this page created its own Supabase client with the
 * public anon key and read and wrote an `expert_messages` table directly from
 * the browser. That table has never existed, so the page silently failed to
 * load and, on send, showed the provider an alert asking whether they had
 * "created the expert_messages table in Supabase".
 *
 * Creating the table would have been worse than leaving it missing. The anon
 * key ships inside the browser bundle, this project has no row-level security
 * anywhere, and every other feature reaches the database through the API. So a
 * working version of this page would have let anyone who opened the site read
 * and write every message between every provider and every customer.
 *
 * Provider/customer communication is scheduled work (Priority 2). It will go
 * through the API with ownership scoping like everything else, rather than
 * direct browser access to a shared key.
 */

import React from "react";
import { MessageSquare, ShieldCheck, Clock } from "lucide-react";

export default function MessagesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Messages</h1>
        <p className="text-gray-500 dark:text-gray-400">
          Talk to customers about an opportunity you have accepted.
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-12 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 bg-blue-50 dark:bg-gray-700 rounded-full flex items-center justify-center mb-6">
          <Clock className="w-10 h-10 text-blue-600 dark:text-blue-400" />
        </div>
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">Coming Soon</h2>
        <p className="text-gray-500 dark:text-gray-400 max-w-lg mb-8">
          In-platform messaging is being built as part of the next release. Until then, the
          customer&apos;s email address and telephone number appear on an opportunity once you
          accept it, so you can reach them directly.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl w-full">
          <div className="p-4 border border-gray-100 dark:border-gray-700 rounded-lg flex gap-4 text-left">
            <MessageSquare className="w-6 h-6 text-indigo-500 shrink-0" />
            <div>
              <h4 className="font-semibold text-gray-900 dark:text-white">One thread per job</h4>
              <p className="text-sm text-gray-500">
                Conversations stay attached to the opportunity they belong to.
              </p>
            </div>
          </div>
          <div className="p-4 border border-gray-100 dark:border-gray-700 rounded-lg flex gap-4 text-left">
            <ShieldCheck className="w-6 h-6 text-green-500 shrink-0" />
            <div>
              <h4 className="font-semibold text-gray-900 dark:text-white">Private to you</h4>
              <p className="text-sm text-gray-500">
                Only you and that customer can see the conversation.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
