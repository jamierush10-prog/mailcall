"use client";

import { useState, useEffect } from "react";
import { auth, db } from "../lib/firebase";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, setDoc, collection, query, where, getDocs, addDoc, serverTimestamp, onSnapshot, orderBy, updateDoc, writeBatch } from "firebase/firestore";
import { useAuth } from "../lib/auth";

function calculateDeliveryDate(sentDate = new Date()) {
  let date = new Date(sentDate);
  let cyclesCount = 0;

  while (cyclesCount < 2) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() === 0) {
      date.setDate(date.getDate() + 1);
    }
    cyclesCount++;
  }

  date.setHours(12, 0, 0, 0);
  return date;
}

export default function Home() {
  const { user, loading } = useAuth();
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mailboxAddress, setMailboxAddress] = useState("");
  const [error, setError] = useState("");

  // Letter Composing State
  const [activeDraftId, setActiveDraftId] = useState(null);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [letterBody, setLetterBody] = useState("");
  const [mailStatus, setMailStatus] = useState("");

  // System Logs State
  const [inbox, setInbox] = useState([]);
  const [allCorrespondence, setAllCorrespondence] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [directoryUsers, setDirectoryUsers] = useState([]);

  // Modal Interactive States
  const [isInboxOpen, setIsInboxOpen] = useState(false);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [isAddressBookOpen, setIsAddressBookOpen] = useState(false);
  const [isPurposeOpen, setIsPurposeOpen] = useState(false);
  const [activeLetter, setActiveLetter] = useState(null);
  
  // Invitation Modal Specific State
  const [inviteModalData, setInviteModalData] = useState(null);
  const [copied, setCopied] = useState(false);

  // --- OBLITERATE FILTERS DATA STREAM ---
  useEffect(() => {
    if (!user) return;

    // Zero filters, zero index constraints, zero rules blocks.
    const rawLettersQuery = query(collection(db, "letters"));

    const unsubscribe = onSnapshot(rawLettersQuery, (snapshot) => {
      const rawDocs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      // Dump EVERY SINGLE document straight into the ledger state without filtering
      setAllCorrespondence(rawDocs);
      setInbox(rawDocs.filter(l => l.status === "pending"));
    }, (err) => {
      console.error("Firestore read error tracker:", err);
    });

    const fetchDirectory = async () => {
      try {
        const usersSnapshot = await getDocs(collection(db, "users"));
        setDirectoryUsers(usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      } catch (err) {
        console.error("Directory lookup failure:", err);
      }
    };

    fetchDirectory();
    return () => unsubscribe();
  }, [user]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FDFBF7]">
        <p className="text-stone-500 font-serif italic tracking-wider">Checking the mail slot...</p>
      </div>
    );
  }

  const handleAuth = async (e) => {
    e.preventDefault();
    setError("");
    const cleanEmail = email.trim().toLowerCase();

    try {
      if (isRegistering) {
        const cleanAddress = mailboxAddress.trim().toLowerCase().replace(/\s+/g, "").replace("@", "");
        if (!cleanAddress) {
          setError("Please choose a mailbox address.");
          return;
        }

        const q = query(collection(db, "users"), where("mailboxAddress", "==", cleanAddress));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          setError("This mailbox address is already registered to someone else.");
          return;
        }

        const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
        
        await setDoc(doc(db, "users", userCredential.user.uid), {
          mailboxAddress: cleanAddress,
          createdAt: new Date()
        });
      } else {
        await signInWithEmailAndPassword(auth, cleanEmail, password);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveDraft = async () => {
    setMailStatus("");
    setError("");

    try {
      if (activeDraftId) {
        await updateDoc(doc(db, "letters", activeDraftId), {
          recipientAddress: recipientAddress,
          body: letterBody,
          sentAt: new Date().toISOString()
        });
        setMailStatus("Draft updated.");
      } else {
        const docRef = await addDoc(collection(db, "letters"), {
          senderId: user.uid,
          senderAddress: user.mailboxAddress || "jamie",
          recipientAddress: recipientAddress,
          body: letterBody,
          sentAt: new Date().toISOString(),
          status: "draft"
        });
        setActiveDraftId(docRef.id);
        setMailStatus("Draft saved.");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSendLetter = async (e) => {
    e.preventDefault();
    setMailStatus("");
    setError("");

    try {
      const deliveryDate = calculateDeliveryDate(new Date());
      await addDoc(collection(db, "letters"), {
        senderId: user.uid,
        senderAddress: user.mailboxAddress || "jamie",
        recipientAddress: recipientAddress,
        recipientEmail: recipientAddress.includes("@") ? recipientAddress : "",
        body: letterBody,
        sentAt: new Date().toISOString(),
        deliveryDate: deliveryDate.toISOString(),
        status: "pending"
      });
      setMailStatus("Letter mailed successfully.");
      setRecipientAddress("");
      setLetterBody("");
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredCorrespondence = allCorrespondence.filter((letter) => {
    const queryLower = searchQuery.toLowerCase().trim();
    if (!queryLower) return true;
    return letter.body?.toLowerCase().includes(queryLower);
  });

  return (
    <div className="min-h-screen bg-[#FDFBF7] text-stone-800 font-serif p-6 sm:p-12">
      <header className="max-w-6xl mx-auto flex justify-between items-center border-b border-stone-300 pb-4 mb-10 text-sm">
        <div>
          <h1 className="text-xl font-normal tracking-wider text-stone-900">M A I L C A L L</h1>
          <p className="text-xs text-stone-400 italic">Connected Workspace: @{user?.mailboxAddress || "jamie"}</p>
        </div>
        <button onClick={() => signOut(auth)} className="font-sans text-xs uppercase border border-stone-200 rounded px-3 py-1.5">Sign Out</button>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12">
        <section className="lg:col-span-4 flex flex-col items-center space-y-4">
          <button onClick={() => setIsInboxOpen(true)} className="p-8 border border-stone-200 bg-white rounded-xl text-center w-full">
            <span className="font-sans text-xs uppercase font-bold text-stone-700 block">Open Mailbox ({inbox.length})</span>
          </button>

          <button onClick={() => setIsArchiveOpen(true)} className="p-4 border border-stone-200 bg-stone-50 text-center w-full font-sans text-xs uppercase font-medium">
            Saved Correspondence ({allCorrespondence.length})
          </button>
        </section>

        <section className="lg:col-span-8 space-y-4">
          <form onSubmit={handleSendLetter} className="bg-white border border-stone-200 rounded p-6 space-y-6 shadow-sm">
            {error && <div className="p-3 bg-red-50 text-red-700 text-xs rounded border">{error}</div>}
            {mailStatus && <div className="p-3 bg-stone-50 text-stone-700 text-xs rounded border">{mailStatus}</div>}

            <div className="flex items-center space-x-3 border-b pb-3 font-sans text-sm">
              <span className="text-stone-400 w-8">To:</span>
              <input type="text" required placeholder="friend@email.com or handle" value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} className="w-full bg-transparent focus:outline-none" />
            </div>

            <textarea required rows={10} placeholder="Write your letter..." value={letterBody} onChange={(e) => setLetterBody(e.target.value)} className="w-full bg-transparent focus:outline-none resize-none leading-relaxed font-serif" />

            <div className="flex justify-between items-center pt-4 border-t">
              <button type="button" onClick={handleSaveDraft} className="text-xs font-sans text-stone-500 border rounded px-4 py-2">Save Draft</button>
              <button type="submit" className="bg-stone-900 text-white font-serif px-6 py-2 rounded text-sm">Seal & Send</button>
            </div>
          </form>
        </section>
      </main>

      {/* LEDGER OVERVIEW MODAL */}
      {isArchiveOpen && (
        <div className="fixed inset-0 bg-stone-900/40 flex items-center justify-center p-4 z-50">
          <div className="bg-[#FDFBF7] border border-stone-300 max-w-2xl w-full rounded-lg p-6 max-h-[85vh] flex flex-col">
            <div className="flex justify-between items-center border-b pb-3 mb-4">
              <h3 className="text-lg font-normal text-stone-900">Correspondence Ledger</h3>
              <button onClick={() => setIsArchiveOpen(false)} className="font-sans text-xs uppercase text-stone-400">Close</button>
            </div>

            <div className="mb-4">
              <input type="text" placeholder="Filter body text..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-white px-4 py-2 border rounded text-sm focus:outline-none" />
            </div>

            <div className="overflow-y-auto flex-1 space-y-3">
              {filteredCorrespondence.length === 0 ? (
                <p className="text-stone-400 italic text-sm text-center py-8">No records found in database.</p>
              ) : (
                filteredCorrespondence.map((letter) => (
                  <div key={letter.id} className="bg-white border p-4 rounded shadow-2xs">
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-mono text-xs font-bold text-stone-600">To: {letter.recipientAddress || letter.recipientEmail}</span>
                      <span className="text-xs uppercase tracking-wider text-stone-400 font-sans bg-stone-100 px-1.5 py-0.5 rounded">{letter.status}</span>
                    </div>
                    <p className="text-sm text-stone-700 italic">"{letter.body}"</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}