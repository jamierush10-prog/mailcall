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

  // --- RAW INDEXLESS FIREBASE DATA STREAM ---
  useEffect(() => {
    if (!user) return;

    const myHandle = (user.mailboxAddress || "").toLowerCase().trim();
    const rawLettersQuery = query(collection(db, "letters"));

    const unsubscribe = onSnapshot(rawLettersQuery, (snapshot) => {
      const now = new Date();
      const rawDocs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      const parseTime = (field) => {
        if (!field) return 0;
        if (field.toDate) return field.toDate().getTime();
        if (typeof field === "string") {
          const cleanStr = field.replace(/\sat\s/, " ");
          const parsed = Date.parse(cleanStr);
          return isNaN(parsed) ? 0 : parsed;
        }
        return new Date(field).getTime() || 0;
      };

      // 1. INBOX LIST SEPARATION FILTER
      const incomingInbox = rawDocs
        .filter(letter => {
          if (letter.status !== "pending") return false;
          const recAddress = (letter.recipientAddress || "").toLowerCase().trim();
          const isMeRecipient = letter.recipientId === user.uid || recAddress === myHandle;
          if (!isMeRecipient) return false;

          const dDate = letter.deliveryDate?.toDate ? letter.deliveryDate.toDate() : new Date(letter.deliveryDate);
          return dDate <= now;
        })
        .sort((a, b) => parseTime(b.deliveryDate) - parseTime(a.deliveryDate));

      setInbox(incomingInbox);

      // 2. SAVED CORRESPONDENCE LEDGER FILTER
      const ledgerLogs = rawDocs
        .filter(letter => {
          const isDraft = letter.status === "draft";
          const sndAddress = (letter.senderAddress || "").toLowerCase().trim();
          const recAddress = (letter.recipientAddress || "").toLowerCase().trim();
          
          const amISender = letter.senderId === user.uid || sndAddress === myHandle;
          const amIRecipient = letter.recipientId === user.uid || recAddress === myHandle;

          const isInvitePending = amISender && letter.recipientEmail && letter.status === "pending";
          const isSentByMe = amISender && !isDraft && !isInvitePending;
          
          const dDate = letter.deliveryDate?.toDate ? letter.deliveryDate.toDate() : (letter.deliveryDate ? new Date(letter.deliveryDate) : null);
          const isSavedIt = amIRecipient && dDate && dDate <= now && letter.status === "archived";

          return isSentByMe || isDraft || isInvitePending || isSavedIt;
        })
        .sort((a, b) => parseTime(b.sentAt) - parseTime(a.sentAt));

      setAllCorrespondence(ledgerLogs);
    }, (err) => {
      console.error("Database seed stream broken:", err);
    });

    const fetchDirectory = async () => {
      try {
        const usersSnapshot = await getDocs(collection(db, "users"));
        const usersList = usersSnapshot.docs
          .map(doc => ({ id: doc.id, ...doc.data() }))
          .filter(u => (u.mailboxAddress || "").toLowerCase().trim() !== myHandle);
        setDirectoryUsers(usersList);
      } catch (err) {
        console.error("Directory fetch crash:", err);
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

        const inviteQuery = query(
          collection(db, "letters"),
          where("recipientEmail", "==", cleanEmail)
        );
        const inviteSnapshot = await getDocs(inviteQuery);
        
        if (!inviteSnapshot.empty) {
          const batch = writeBatch(db);
          inviteSnapshot.docs.forEach((inviteDoc) => {
            const docRef = doc(db, "letters", inviteDoc.id);
            batch.update(docRef, {
              recipientId: userCredential.user.uid,
              recipientAddress: cleanAddress,
              recipientEmail: "" 
            });
          });
          await batch.commit();
        }
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

    const rawInput = recipientAddress.trim().toLowerCase();
    if (!letterBody.trim() && !rawInput) {
      setError("Cannot save an entirely empty sheet as a draft.");
      return;
    }

    const isEmailFormat = rawInput.includes("@") && rawInput.includes(".");
    const cleanInput = isEmailFormat ? rawInput : rawInput.replace("@", "");

    try {
      if (activeDraftId) {
        await updateDoc(doc(db, "letters", activeDraftId), {
          recipientAddress: isEmailFormat ? "" : cleanInput,
          recipientEmail: isEmailFormat ? cleanInput : "",
          body: letterBody,
          sentAt: new Date().toISOString()
        });
        setMailStatus("Draft modifications updated in your correspondence drawer.");
      } else {
        const docRef = await addDoc(collection(db, "letters"), {
          senderId: user.uid,
          senderAddress: user.mailboxAddress,
          recipientId: "",
          recipientAddress: isEmailFormat ? "" : cleanInput,
          recipientEmail: isEmailFormat ? cleanInput : "",
          body: letterBody,
          sentAt: new Date().toISOString(),
          deliveryDate: null,
          status: "draft",
          isRead: false
        });
        setActiveDraftId(docRef.id);
        setMailStatus("Letter sheet saved to drafts inside your correspondence drawer.");
      }
    } catch (err) {
      setError("Failed to cache draft document state.");
      console.error(err);
    }
  };

  const handleSendLetter = async (e) => {
    e.preventDefault();
    setMailStatus("");
    setError("");

    const rawInput = recipientAddress.trim().toLowerCase();
    const isEmailFormat = rawInput.includes("@") && rawInput.includes(".");
    const cleanInput = isEmailFormat ? rawInput : rawInput.replace("@", "");

    if (!isEmailFormat && cleanInput === user.mailboxAddress) {
      setError("You cannot mail a letter to your own mailbox.");
      return;
    }

    try {
      let resolvedRecipientId = "";
      let resolvedRecipientAddress = "";
      let resolvedRecipientEmail = "";

      if (isEmailFormat) {
        resolvedRecipientEmail = cleanInput;
        resolvedRecipientAddress = ""; 
      } else {
        const q = query(collection(db, "users"), where("mailboxAddress", "==", cleanInput));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          const recipientDoc = querySnapshot.docs[0];
          resolvedRecipientId = recipientDoc.id;
          resolvedRecipientAddress = cleanInput;
        } else {
          setError(`No mailbox found with the handle address @${cleanInput}`);
          return;
        }
      }

      const deliveryDate = calculateDeliveryDate(new Date());

      if (activeDraftId) {
        await updateDoc(doc(db, "letters", activeDraftId), {
          recipientId: resolvedRecipientId,
          recipientAddress: resolvedRecipientAddress,
          recipientEmail: resolvedRecipientEmail,
          body: letterBody,
          sentAt: new Date().toISOString(),
          deliveryDate: deliveryDate.toISOString(),
          status: "pending"
        });
      } else {
        await addDoc(collection(db, "letters"), {
          senderId: user.uid,
          senderAddress: user.mailboxAddress,
          recipientId: resolvedRecipientId,
          recipientAddress: resolvedRecipientAddress,
          recipientEmail: resolvedRecipientEmail,
          body: letterBody,
          sentAt: new Date().toISOString(),
          deliveryDate: deliveryDate.toISOString(),
          status: "pending",
          isRead: false
        });
      }

      if (isEmailFormat) {
        setInviteModalData({
          email: cleanInput,
          dateString: deliveryDate.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        });
        setCopied(false);
      } else {
        setMailStatus("Letter dropped in the collection box. It is now out of your hands.");
      }

      setRecipientAddress("");
      setLetterBody("");
      setActiveDraftId(null);
    } catch (err) {
      setError("The post office failed to accept your letter.");
      console.error(err);
    }
  };

  const handleLoadDraft = (draftLetter) => {
    setActiveDraftId(draftLetter.id);
    setRecipientAddress(draftLetter.recipientEmail || `@${draftLetter.recipientAddress}`);
    setLetterBody(draftLetter.body);
    setIsArchiveOpen(false);
    setMailStatus("Loaded draft text onto your composition workspace.");
    setError("");
  };

  const handleOpenLetter = async (letter) => {
    if (letter.status === "draft") {
      handleLoadDraft(letter);
      return;
    }
    setActiveLetter(letter);
    if (!letter.isRead && letter.recipientId === user.uid) {
      try {
        await updateDoc(doc(db, "letters", letter.id), { isRead: true });
      } catch (err) {
        console.error("Could not update read status:", err);
      }
    }
  };

  const handleArchiveLetter = async (letterId) => {
    try {
      await updateDoc(doc(db, "letters", letterId), { status: "archived" });
      setActiveLetter(null);
      setIsInboxOpen(false); 
    } catch (err) {
      console.error("Could not archive letter:", err);
    }
  };

  const handleTrashLetter = async (letterId) => {
    try {
      await updateDoc(doc(db, "letters", letterId), { status: "trashed" });
      setActiveLetter(null);
      setIsInboxOpen(false);
    } catch (err) {
      console.error("Could not trash letter:", err);
    }
  };

  const handleSelectContact = (address) => {
    setRecipientAddress(`@${address}`);
    setIsAddressBookOpen(false);
    setMailStatus("");
    setError("");
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
  };

  const filteredCorrespondence = allCorrespondence.filter((letter) => {
    const queryLower = searchQuery.toLowerCase().trim();
    if (!queryLower) return true;

    return (
      (letter.senderAddress && letter.senderAddress.toLowerCase().includes(queryLower)) ||
      (letter.recipientAddress && letter.recipientAddress.toLowerCase().includes(queryLower)) ||
      (letter.recipientEmail && letter.recipientEmail.toLowerCase().includes(queryLower)) ||
      (letter.body && letter.body.toLowerCase().includes(queryLower))
    );
  });

  const getPostmarkDisplay = (field) => {
    if (!field) return "unposted";
    if (field.toDate) return field.toDate().toLocaleDateString();
    const cleanStr = typeof field === "string" ? field.replace(/\sat\s/, " ") : field;
    const d = new Date(cleanStr);
    return isNaN(d.getTime()) ? "unposted" : d.toLocaleDateString();
  };

  // --- LOGGED IN UI WORKSPACE ---
  if (user) {
    const inviteTextPayload = inviteModalData 
      ? `I just wrote you a letter on Mailcall. To open your mailbox and read it, go to ${window.location.origin} and register an account using this email: ${inviteModalData.email}\n\nBecause Mailcall uses a deliberate post cycle, your letter will drop into your mailbox loop exactly this upcoming ${inviteModalData.dateString} at Noon.`
      : "";

    return (
      <div className="min-h-screen bg-[#FDFBF7] text-stone-800 font-serif selection:bg-stone-200 p-6 sm:p-12">
        <header className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center border-b border-stone-300 pb-4 mb-10 text-sm">
          <div>
            <h1 className="text-xl font-normal tracking-wider text-stone-900">M A I L C A L L</h1>
            <p className="text-xs text-stone-400 italic mt-0.5">Connected Workspace: @{user.mailboxAddress}</p>
          </div>
          <button
            onClick={() => signOut(auth)}
            className="mt-4 sm:mt-0 font-sans text-xs uppercase tracking-widest text-stone-400 hover:text-stone-800 transition-colors border border-stone-200 rounded px-3 py-1.5"
          >
            Sign Out
          </button>
        </header>

        <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12">
          
          {/* Left Column: Post Desk Toolbar */}
          <section className="lg:col-span-4 flex flex-col items-center justify-start pt-6 space-y-4">
            <div className="w-full">
              <h2 className="text-xs uppercase tracking-widest text-stone-400 font-sans font-semibold border-b border-stone-200 pb-2 text-center w-full">
                Post Desk
              </h2>
            </div>
            
            <button
              onClick={() => setIsInboxOpen(true)}
              className="relative group p-8 border border-stone-200 bg-white rounded-xl shadow-sm hover:shadow-md hover:border-stone-300 transition-all text-center flex flex-col items-center w-64"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor" className="w-20 h-20 text-stone-600 transition-transform group-hover:scale-105">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 3.75H6.75A2.25 2.25 0 0 0 4.5 6v12a2.25 2.25 0 0 0 2.25 2.25h10.5A2.25 2.25 0 0 0 19.5 18V6a2.25 2.25 0 0 0-2.25-2.25H15M9 3.75V1.5h6v2.25M9 3.75h6m-6 0v6l3-1.5 3 1.5v-6" />
              </svg>
              <span className="font-sans text-xs uppercase tracking-wider font-semibold text-stone-700 mt-4 block">
                Open Mailbox ({inbox.length})
              </span>
              <span className="text-[10px] text-stone-400 font-sans mt-2 block italic">
                Mail delivered Mon – Sat at Noon CT
              </span>
            </button>

            <button
              onClick={() => setIsArchiveOpen(true)}
              className="group p-4 border border-stone-200 bg-stone-50/50 hover:bg-stone-50 rounded-lg text-center flex flex-col items-center w-64 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor" className="w-5 h-5 text-stone-500 mb-1">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.856-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h12A2.25 2.25 0 0 1 20.25 6v3.776m-12 4.499h6m-6 3h6" />
              </svg>
              <span className="font-sans text-xs uppercase tracking-widest text-stone-600 font-medium">
                Saved Correspondence ({allCorrespondence.length})
              </span>
            </button>

            <button
              onClick={() => setIsAddressBookOpen(true)}
              className="group p-4 border border-stone-200 bg-stone-50/50 hover:bg-stone-50 rounded-lg text-center flex flex-col items-center w-64 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor" className="w-5 h-5 text-stone-500 mb-1">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 9h3.75M15 12h3.75M15 15h3.75M4.5 19.5h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5a2.25 2.25 0 0 0 2.25 2.25Zm3-10.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM6 12a2.25 2.25 0 0 0-2.25 2.25v.375c0 .621.504 1.125 1.125 1.125h4.25A1.125 1.125 0 0 0 10 14.625v-.375A2.25 2.25 0 0 0 7.75 12H6Z" />
              </svg>
              <span className="font-sans text-xs uppercase tracking-widest text-stone-600 font-medium">
                Address Book
              </span>
            </button>

            <button
              onClick={() => setIsPurposeOpen(true)}
              className="group p-4 border border-dashed border-stone-300 hover:border-stone-400 bg-transparent rounded-lg text-center flex flex-col items-center w-64 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor" className="w-5 h-5 text-stone-400 mb-1 group-hover:text-stone-600">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
              </svg>
              <span className="font-sans text-xs uppercase tracking-widest text-stone-400 group-hover:text-stone-600 font-medium">
                Our Purpose
              </span>
            </button>
          </section>

          {/* Right Column: Stationery Slate Desk */}
          <section className="lg:col-span-8 space-y-10">
            <div className="space-y-4">
              <div className="flex justify-between items-center border-b border-stone-200 pb-2">
                <h2 className="text-xs uppercase tracking-widest text-stone-400 font-sans font-semibold">
                  Compose Letter {activeDraftId && <span className="text-stone-500 font-serif lowercase italic normal-case ml-2">(editing saved draft)</span>}
                </h2>
                {activeDraftId && (
                  <button 
                    onClick={() => { setActiveDraftId(null); setRecipientAddress(""); setLetterBody(""); setMailStatus(""); }}
                    className="font-sans text-[10px] uppercase tracking-wider text-stone-400 hover:text-stone-700"
                  >
                    Clear Draft Sheet
                  </button>
                )}
              </div>
              
              <form onSubmit={handleSendLetter} className="bg-white border border-stone-200 rounded p-6 sm:p-8 shadow-sm space-y-6">
                {error && <div className="p-3 bg-red-50 text-red-700 text-xs rounded border border-red-100 italic">{error}</div>}
                {mailStatus && <div className="p-3 bg-stone-50 text-stone-700 text-xs rounded border border-stone-200 italic">{mailStatus}</div>}

                <div className="flex items-center space-x-3 border-b border-stone-100 pb-3 font-sans text-sm">
                  <span className="text-stone-400 font-serif text-base w-8">To:</span>
                  <input
                    type="text"
                    required
                    placeholder="handle or friend@email.com"
                    value={recipientAddress}
                    onChange={(e) => setRecipientAddress(e.target.value)}
                    className="w-full bg-transparent focus:outline-none text-stone-800 placeholder-stone-300 font-mono pl-1"
                  />
                </div>

                <div className="relative">
                  <textarea
                    required
                    rows={14}
                    placeholder="Write something meaningful... take your time."
                    value={letterBody}
                    onChange={(e) => setLetterBody(e.target.value)}
                    className="w-full bg-transparent focus:outline-none text-stone-800 placeholder-stone-300 resize-none leading-relaxed font-serif text-base"
                    style={{
                      backgroundImage: "linear-gradient(transparent, transparent 27px, #f1ece4 27px, #f1ece4 28px)",
                      backgroundSize: "100% 28px",
                      lineHeight: "28px",
                      paddingTop: "6px"
                    }}
                  />
                </div>

                <div className="flex justify-between items-center pt-4 border-t border-stone-100">
                  <button
                    type="button"
                    onClick={handleSaveDraft}
                    className="text-xs font-sans text-stone-500 hover:text-stone-800 border border-stone-200 hover:border-stone-400 rounded bg-stone-50/50 px-4 py-2 transition-colors"
                  >
                    Save Draft
                  </button>

                  <button type="submit" className="bg-stone-900 hover:bg-stone-800 text-white font-serif px-6 py-2 rounded text-sm tracking-wide transition-colors">
                    Seal & Mail Letter
                  </button>
                </div>
              </form>
            </div>
          </section>

        </main>

        {/* MODAL 1: Inside the Mailbox */}
        {isInboxOpen && (
          <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-40">
            <div className="bg-[#FDFBF7] border border-stone-300 max-w-lg w-full rounded-lg shadow-xl p-6 sm:p-8 relative max-h-[85vh] flex flex-col">
              <div className="flex justify-between items-center border-b border-stone-200 pb-3 mb-4">
                <h3 className="text-lg font-normal text-stone-900 tracking-wide">Inside the Mailbox</h3>
                <button onClick={() => setIsInboxOpen(false)} className="font-sans text-xs uppercase text-stone-400 hover:text-stone-800 tracking-wider transition-colors">Close</button>
              </div>

              <div className="overflow-y-auto flex-1 pr-1 space-y-3">
                {inbox.length === 0 ? (
                  <p className="text-stone-400 italic text-sm text-center py-8">Your mailbox is currently empty.</p>
                ) : (
                  inbox.map((letter) => (
                    <div 
                      key={letter.id}
                      onClick={() => handleOpenLetter(letter)}
                      className="bg-white border border-stone-200 hover:border-stone-400 rounded p-4 cursor-pointer flex justify-between items-center transition-all shadow-2xs group"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="font-mono text-sm text-stone-700 font-semibold">@{letter.senderAddress}</span>
                          {!letter.isRead && <span className="h-2 w-2 rounded-full bg-stone-800" />}
                        </div>
                        <p className="text-xs text-stone-400 font-sans">Delivered: {getPostmarkDisplay(letter.deliveryDate)}</p>
                      </div>
                      <span className="text-xs font-sans text-stone-400 group-hover:text-stone-700 transition-colors">Break Seal &rarr;</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* MODAL 2: CORRESPONDENCE LEDGER ARCHIVE OVERVIEW */}
        {isArchiveOpen && (
          <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-40">
            <div className="bg-[#FDFBF7] border border-stone-300 max-w-2xl w-full rounded-lg shadow-xl p-6 sm:p-8 relative max-h-[85vh] flex flex-col">
              
              <div className="flex justify-between items-center border-b border-stone-200 pb-3 mb-4">
                <h3 className="text-lg font-normal text-stone-900 tracking-wide">Correspondence Ledger</h3>
                <button onClick={() => setIsArchiveOpen(false)} className="font-sans text-xs uppercase text-stone-400 hover:text-stone-800 tracking-wider transition-colors">Close Ledger</button>
              </div>

              <div className="mb-4 relative">
                <input 
                  type="text"
                  placeholder="Search ledger by handle, email, or content..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white px-4 py-2 border border-stone-200 focus:border-stone-400 rounded text-sm font-sans focus:outline-none placeholder-stone-300"
                />
              </div>

              <div className="overflow-y-auto flex-1 pr-1 space-y-3">
                {filteredCorrespondence.length === 0 ? (
                  <p className="text-stone-400 italic text-sm text-center py-8">No matching records found in your archive.</p>
                ) : (
                  filteredCorrespondence.map((letter) => {
                    const isDraft = letter.status === "draft";
                    const isInvitePending = letter.recipientEmail && letter.status === "pending";
                    const isSentByMe = !isDraft && !isInvitePending;
                    
                    return (
                      <div 
                        key={letter.id}
                        onClick={() => handleOpenLetter(letter)}
                        className={`bg-white border border-stone-200 hover:border-stone-400 rounded p-4 cursor-pointer transition-all flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-2 sm:space-y-0 group ${isDraft ? 'border-dashed border-stone-300 bg-amber-50/10' : ''}`}
                      >
                        <div className="space-y-1 font-serif">
                          <div className="flex items-center space-x-2">
                            {isDraft && (
                              <span className="text-xs font-sans uppercase tracking-wider text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-medium">Draft Sheet</span>
                            )}
                            {isInvitePending && (
                              <span className="text-xs font-sans uppercase tracking-wider text-stone-500 bg-stone-200 border border-stone-300/60 px-1.5 py-0.5 rounded font-medium">Pending Invitation</span>
                            )}
                            {isSentByMe && (
                              <span className="text-xs font-sans uppercase tracking-wider text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded">To Outbox</span>
                            )}

                            <span className="font-mono text-sm text-stone-800 font-semibold">
                              {isInvitePending 
                                ? letter.recipientEmail 
                                : `@${letter.recipientAddress || "unaddressed"}`
                              }
                            </span>
                          </div>
                          <p className="text-xs text-stone-600 line-clamp-1 italic max-w-md">"{letter.body || "blank sheet..."}"</p>
                        </div>

                        <div className="text-right font-sans text-xs text-stone-400">
                          {isDraft ? (
                            <span className="text-amber-700 italic block font-serif">Click to Edit &rarr;</span>
                          ) : isInvitePending ? (
                            <span className="text-stone-400 block italic">Awaiting Sign Up</span>
                          ) : (
                            <span className="block">Postmark: {getPostmarkDisplay(letter.sentAt)}</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* MODAL 3: ADDRESS BOOK REGISTRY DIRECTORY */}
        {isAddressBookOpen && (
          <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-40">
            <div className="bg-[#FDFBF7] border border-stone-300 max-w-md w-full rounded-lg shadow-xl p-6 relative max-h-[80vh] flex flex-col">
              <div className="flex justify-between items-center border-b border-stone-200 pb-3 mb-4">
                <h3 className="text-lg font-normal text-stone-900 tracking-wide">Registry Directory</h3>
                <button onClick={() => setIsAddressBookOpen(false)} className="font-sans text-xs uppercase text-stone-400 hover:text-stone-800 tracking-wider transition-colors">Close</button>
              </div>

              <div className="overflow-y-auto flex-1 pr-1 space-y-2">
                {directoryUsers.length === 0 ? (
                  <p className="text-stone-400 italic text-sm text-center py-6">No other mailboxes registered yet.</p>
                ) : (
                  directoryUsers.map((u) => (
                    <div
                      key={u.id}
                      onClick={() => handleSelectContact(u.mailboxAddress)}
                      className="bg-white border border-stone-200 hover:border-stone-400 p-3.5 rounded cursor-pointer transition-all flex items-center justify-between group shadow-2xs"
                    >
                      <div className="flex items-center space-x-1 font-mono text-sm">
                        <span className="text-stone-400">@</span>
                        <span className="text-stone-800 font-bold">{u.mailboxAddress}</span>
                      </div>
                      <span className="font-sans text-[11px] uppercase tracking-wider text-stone-400 group-hover:text-stone-700 transition-colors">Write Letter &rarr;</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* MODAL 4: INDIVIDUAL STATIONERY LETTER READER */}
        {activeLetter && (
          <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <div className="bg-white border border-stone-300 max-w-2xl w-full rounded shadow-2xl p-6 sm:p-10 relative flex flex-col max-h-[90vh]">
              
              <div className="flex justify-between items-center border-b border-stone-200 pb-3 mb-6 font-sans text-xs text-stone-400">
                <div>
                  <span>From: <strong className="font-mono text-stone-600 text-sm">@{activeLetter.senderAddress}</strong></span>
                  <span className="mx-2">|</span>
                  <span>To: <strong className="font-mono text-stone-600 text-sm">{activeLetter.recipientEmail ? activeLetter.recipientEmail : `@${activeLetter.recipientAddress || "unaddressed"}`}</strong></span>
                  <span className="mx-2">|</span>
                  <span>Date: {getPostmarkDisplay(activeLetter.sentAt)}</span>
                </div>
                <button onClick={() => setActiveLetter(null)} className="uppercase tracking-wider hover:text-stone-800 transition-colors">Fold Paper</button>
              </div>

              <div className="flex-1 overflow-y-auto mb-8 pr-2">
                <p 
                  className="whitespace-pre-wrap leading-relaxed text-stone-800 font-serif text-base pb-4"
                  style={{
                    backgroundImage: "linear-gradient(transparent, transparent 27px, #f6f1e9 27px, #f6f1e9 28px)",
                    backgroundSize: "100% 28px",
                    lineHeight: "28px",
                    paddingTop: "4px"
                  }}
                >
                  {activeLetter.body}
                </p>
              </div>

              {activeLetter.recipientId === user.uid && activeLetter.status === "pending" && (
                <div className="flex justify-between items-center border-t border-stone-100 pt-4 font-sans text-xs uppercase tracking-widest">
                  <button
                    onClick={() => handleTrashLetter(activeLetter.id)}
                    className="text-red-700 hover:text-red-900 transition-colors border border-red-100 hover:border-red-200 bg-red-50/30 px-3 py-2 rounded"
                  >
                    Move to Trash
                  </button>
                  
                  <button
                    onClick={() => handleArchiveLetter(activeLetter.id)}
                    className="text-stone-600 hover:text-stone-900 transition-colors border border-stone-200 hover:border-stone-400 px-4 py-2 rounded bg-stone-50"
                  >
                    File in Archive
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* MODAL 5: SHAREABLE INVITATION SNIPPET DIALOG */}
        {inviteModalData && (
          <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <div className="bg-[#FDFBF7] border border-stone-300 max-w-lg w-full rounded-lg shadow-xl p-6 sm:p-8 relative font-serif">
              <div className="border-b border-stone-200 pb-3 mb-4 flex justify-between items-center">
                <h3 className="text-base font-sans uppercase tracking-widest text-stone-600 font-semibold">Share Invite Loop</h3>
                <button onClick={() => setInviteModalData(null)} className="font-sans text-xs uppercase text-stone-400 hover:text-stone-800 tracking-wider">Close</button>
              </div>
              <p className="text-xs text-stone-500 font-sans mb-4 leading-relaxed">
                Copy the snippet below to send over text, social media, or email. Your letter has been securely staged in the cloud.
              </p>
              <div className="bg-white border border-stone-200 rounded p-4 text-xs font-serif leading-relaxed text-stone-700 select-all mb-5 relative max-h-48 overflow-y-auto shadow-2xs whitespace-pre-wrap">
                {inviteTextPayload}
              </div>
              <div className="flex justify-end space-x-3 font-sans text-xs">
                <button
                  onClick={() => copyToClipboard(inviteTextPayload)}
                  className={`px-4 py-2 rounded border transition-all uppercase tracking-wider ${copied ? 'bg-stone-100 text-stone-500 border-stone-200' : 'bg-stone-900 text-white border-stone-900 hover:bg-stone-800'}`}
                >
                  {copied ? "Copied!" : "Copy Snippet Text"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MODAL 6: MANIFESTO & PURPOSE EXPLANATION */}
        {isPurposeOpen && (
          <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <div className="bg-white border border-stone-300 max-w-xl w-full rounded shadow-2xl p-6 sm:p-8 relative flex flex-col max-h-[85vh]">
              <div className="flex justify-between items-center border-b border-stone-200 pb-3 mb-5">
                <h3 className="text-xs uppercase tracking-widest text-stone-400 font-sans font-semibold">About Mailcall</h3>
                <button onClick={() => setIsPurposeOpen(false)} className="font-sans text-xs uppercase text-stone-400 hover:text-stone-800 tracking-wider transition-colors">Close</button>
              </div>
              <div className="overflow-y-auto flex-1 pr-2 space-y-5 text-sm text-stone-700 leading-relaxed font-serif">
                <div>
                  <h4 className="text-stone-900 font-sans text-xs uppercase tracking-wider font-bold mb-1">The Purpose</h4>
                  <p>Mailcall is an intentional experiment designed to reject the exhausting pace of modern digital instant messaging. In a world saturated with immediate notifications, typing boxes, and constant availability, our minds have lost the capacity for deep, contemplative communication. This application acts as a private harbor—restoring the slow, deliberate rhythm of analog letter-writing back to your digital desk.</p>
                </div>
                <div>
                  <h4 className="text-stone-900 font-sans text-xs uppercase tracking-wider font-bold mb-1">How It Works</h4>
                  <ul className="list-disc pl-5 space-y-2 text-stone-600 text-xs">
                    <li><strong className="text-stone-800 font-sans uppercase tracking-wide text-[10px] block mt-0.5">The Two-Cycle Rule:</strong> Every letter you mail undergoes a mandatory transit cycle. It does not drop into the recipient's mailbox instantly. Instead, it travels through the system and is held in transit for exactly two post cycles.</li>
                    <li><strong className="text-stone-800 font-sans uppercase tracking-wide text-[10px] block mt-0.5">Fixed Mail Call:</strong> Delivery runs strictly Monday through Saturday at exactly Noon Central Time. If a letter’s transit period wraps up on a Sunday, it will wait securely on the sorting shelf until the official Monday mail call.</li>
                    <li><strong className="text-stone-800 font-sans uppercase tracking-wide text-[10px] block mt-0.5">The Quiet Mailbox:</strong> To respect your peace, there are no unread notification counts, flashing numbers, or alert popups on your main dashboard desk. To see if the post has arrived, you must intentionally open your Post Box door to look inside.</li>
                    <li><strong className="text-stone-800 font-sans uppercase tracking-wide text-[10px] block mt-0.5">Immutable Inboxes:</strong> Letters wait inside your mailbox until you explicitly sit down to read them. Once unsealed, you have a conscious choice: permanently move the paper to the Trash, or file it safely away in your permanent Saved Correspondence ledger.</li>
                  </ul>
                </div>
                <p className="text-xs text-stone-400 italic pt-2 border-t border-stone-100 font-sans text-center">Take your time. Write with intention.</p>
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }

  // --- LOGGED OUT UI ---
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FDFBF7] p-6 text-stone-800 font-serif selection:bg-stone-200">
      <div className="max-w-md w-full border border-stone-200 bg-white p-8 rounded shadow-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-normal text-stone-900 tracking-wide">M A I L C A L L</h1>
          <p className="text-xs italic text-stone-400 mt-2">Intentional, delayed correspondence.</p>
        </div>

        <form onSubmit={handleAuth} className="space-y-5 font-sans text-sm">
          {error && <div className="p-3 bg-red-50 text-red-700 text-xs rounded border border-red-100 font-serif italic">{error}</div>}

          {isRegistering && (
            <div>
              <label className="block text-stone-500 font-serif mb-1">Desired Mailbox Address</label>
              <div className="relative flex items-center">
                <span className="absolute left-3 text-stone-400 font-mono">@</span>
                <input type="text" required placeholder="penname" value={mailboxAddress} onChange={(e) => setMailboxAddress(e.target.value)} className="w-full pl-8 pr-3 py-2 border border-stone-300 rounded focus:outline-none focus:border-stone-500 font-mono" />
              </div>
            </div>
          )}

          <div>
            <label className="block text-stone-500 font-serif mb-1">Email Address</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded focus:outline-none focus:border-stone-500" />
          </div>

          <div>
            <label className="block text-stone-500 font-serif mb-1">Password</label>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-3 py-2 border border-stone-300 rounded focus:outline-none focus:border-stone-500" />
          </div>

          <button type="submit" className="w-full bg-stone-900 hover:bg-stone-800 text-white font-serif py-2.5 rounded transition-colors text-base tracking-wide">
            {isRegistering ? "Register Mailbox" : "Open Mailbox"}
          </button>
        </form>

        <div className="mt-6 border-t border-stone-100 pt-4 text-center">
          <button onClick={() => { setIsRegistering(!isRegistering); setError(""); }} className="text-xs text-stone-500 hover:text-stone-800 underline underline-offset-4">
            {isRegistering ? "Already have an address? Sign In" : "Need a mailbox address? Register here"}
          </button>
        </div>
      </div>
    </div>
  );
}