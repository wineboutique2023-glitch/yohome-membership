from pathlib import Path

src_path = Path("/mnt/data/Pasted text(13).txt")
src = src_path.read_text(encoding="utf-8")
code = src

code = code.replace(
'''  const [members, setMembers] = useState([]);
  const [checkouts, setCheckouts] = useState([]);''',
'''  const [members, setMembers] = useState([]);
  const [checkouts, setCheckouts] = useState([]);
  const [deletedMembers, setDeletedMembers] = useState([]);
  const [deletedCheckouts, setDeletedCheckouts] = useState([]);'''
)

code = code.replace(
'''    const { data: mData, error: mErr } = await supabase
      .from("members")
      .select("*")
      .order("created_at", { ascending: false });''',
'''    const { data: mData, error: mErr } = await supabase
      .from("members")
      .select("*")
      .eq("deleted", false)
      .order("created_at", { ascending: false });

    const { data: dmData, error: dmErr } = await supabase
      .from("members")
      .select("*")
      .eq("deleted", true)
      .order("created_at", { ascending: false });'''
)

code = code.replace(
'''    const { data: cData, error: cErr } = await supabase
      .from("checkouts")
      .select("*")
      .eq("deleted", false)
      .order("created_at", { ascending: false })
      .limit(1000);''',
'''    const { data: cData, error: cErr } = await supabase
      .from("checkouts")
      .select("*")
      .eq("deleted", false)
      .order("created_at", { ascending: false })
      .limit(1000);

    const { data: dcData, error: dcErr } = await supabase
      .from("checkouts")
      .select("*")
      .eq("deleted", true)
      .order("created_at", { ascending: false })
      .limit(1000);'''
)

code = code.replace(
'''    if (mErr || cErr) {
      alert("Supabase loading error. Please check SQL fields.");
      console.error(mErr || cErr);
    } else {
      setMembers(mData || []);
      setCheckouts(cData || []);
    }''',
'''    if (mErr || cErr || dmErr || dcErr) {
      alert("Supabase loading error. Please check SQL fields.");
      console.error(mErr || cErr || dmErr || dcErr);
    } else {
      setMembers(mData || []);
      setCheckouts(cData || []);
      setDeletedMembers(dmData || []);
      setDeletedCheckouts(dcData || []);
    }'''
)

# add deleted false in addMember payload (only first occurrence)
code = code.replace(
'''      membership_fee: Number(membershipFee || 100),
      status: "active",''',
'''      membership_fee: Number(membershipFee || 100),
      status: "active",
      deleted: false,''', 1
)

old_delete_member = '''  async function deleteMember(member) {
    if (!isOwner) return alert("Only owner can delete members.");
    if (!confirm(`Delete member ${member.full_name}?`)) return;
    const { error } = await supabase.from("members").delete().eq("id", member.id);
    if (error) return alert(error.message);
    await loadData();
  }'''
new_delete_member = '''  async function deleteMember(member) {
    if (!isOwner) return alert("Only owner can delete members.");
    if (!confirm(`Move ${member.full_name} to Deleted Members? You can restore it later.`)) return;

    const { error } = await supabase
      .from("members")
      .update({ deleted: true })
      .eq("id", member.id);

    if (error) return alert(error.message);
    await loadData();
  }

  async function restoreMember(member) {
    if (!isOwner) return alert("Only owner can restore members.");
    if (!confirm(`Restore member ${member.full_name}?`)) return;

    const { error } = await supabase
      .from("members")
      .update({ deleted: false })
      .eq("id", member.id);

    if (error) return alert(error.message);
    await loadData();
  }

  async function permanentDeleteMember(member) {
    if (!isOwner) return alert("Only owner can permanently delete members.");
    if (!confirm(`PERMANENTLY delete ${member.full_name}? This cannot be recovered.`)) return;

    const { error } = await supabase.from("members").delete().eq("id", member.id);
    if (error) return alert(error.message);
    await loadData();
  }'''
code = code.replace(old_delete_member, new_delete_member)

old_delete_checkout = '''  async function deleteCheckout(row) {
    if (!isOwner) return alert("Only owner can delete records.");
    if (!confirm(`Delete checkout record for ${row.customer_name || "customer"}?`)) return;

    const { error } = await supabase.from("checkouts").update({ deleted: true }).eq("id", row.id);
    if (error) return alert(error.message);
    await loadData();
  }'''
new_delete_checkout = '''  async function deleteCheckout(row) {
    if (!isOwner) return alert("Only owner can delete records.");
    if (!confirm(`Move checkout record for ${row.customer_name || "customer"} to Deleted Records? You can restore it later.`)) return;

    const { error } = await supabase.from("checkouts").update({ deleted: true }).eq("id", row.id);
    if (error) return alert(error.message);
    await loadData();
  }

  async function restoreCheckout(row) {
    if (!isOwner) return alert("Only owner can restore records.");
    if (!confirm(`Restore checkout record for ${row.customer_name || "customer"}?`)) return;

    const { error } = await supabase.from("checkouts").update({ deleted: false }).eq("id", row.id);
    if (error) return alert(error.message);
    await loadData();
  }

  async function permanentDeleteCheckout(row) {
    if (!isOwner) return alert("Only owner can permanently delete records.");
    if (!confirm(`PERMANENTLY delete checkout record for ${row.customer_name || "customer"}? This cannot be recovered.`)) return;

    const { error } = await supabase.from("checkouts").delete().eq("id", row.id);
    if (error) return alert(error.message);
    await loadData();
  }'''
code = code.replace(old_delete_checkout, new_delete_checkout)

old_settings_end = '''            <section className="panel">
              <h3>Seller / Therapist Names</h3>
              <form onSubmit={addSeller} className="form">
                <label>Add Name</label>
                <input value={sellerInput} onChange={(e) => setSellerInput(e.target.value)} placeholder="e.g. Cedrick, Nice" />
                <button className="primary">Add Name</button>
              </form>
              <div className="memberList">
                {sellers.map((name) => <div className="memberItem" key={name}><strong>{name}</strong><div className="rowBtns"><button className="danger" onClick={() => deleteSeller(name)}>Delete</button></div></div>)}
              </div>
            </section>
          </div>
        )}'''
new_settings_end = '''            <section className="panel">
              <h3>Seller / Therapist Names</h3>
              <form onSubmit={addSeller} className="form">
                <label>Add Name</label>
                <input value={sellerInput} onChange={(e) => setSellerInput(e.target.value)} placeholder="e.g. Cedrick, Nice" />
                <button className="primary">Add Name</button>
              </form>
              <div className="memberList">
                {sellers.map((name) => <div className="memberItem" key={name}><strong>{name}</strong><div className="rowBtns"><button className="danger" onClick={() => deleteSeller(name)}>Delete</button></div></div>)}
              </div>
            </section>

            <section className="panel">
              <h3>Deleted Members</h3>
              <DeletedMembersTable rows={deletedMembers} onRestore={restoreMember} onPermanentDelete={permanentDeleteMember} />
            </section>

            <section className="panel">
              <h3>Deleted Checkout Records</h3>
              <DeletedCheckoutsTable rows={deletedCheckouts} onRestore={restoreCheckout} onPermanentDelete={permanentDeleteCheckout} />
            </section>
          </div>
        )}'''
code = code.replace(old_settings_end, new_settings_end)

components = '''
function DeletedMembersTable({ rows, onRestore, onPermanentDelete }) {
  if (!rows?.length) return <p className="empty">No deleted members.</p>;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Card ID</th>
            <th>Expiry</th>
            <th>Sold By</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{m.full_name}</td>
              <td>{m.phone || ""}</td>
              <td>{m.card_id || ""}</td>
              <td>{m.expiry_date || ""}</td>
              <td>{m.sold_by || ""}</td>
              <td className="rowBtns">
                <button onClick={() => onRestore?.(m)}>Restore</button>
                <button className="danger" onClick={() => onPermanentDelete?.(m)}>Permanent Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeletedCheckoutsTable({ rows, onRestore, onPermanentDelete }) {
  if (!rows?.length) return <p className="empty">No deleted checkout records.</p>;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Therapist</th>
            <th>Service</th>
            <th>Price</th>
            <th>Payment</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
              <td>{r.customer_name || ""}</td>
              <td>{r.therapist || ""}</td>
              <td>{r.service_name || ""}</td>
              <td>${money(r.final_price)}</td>
              <td>{r.payment_method || ""}</td>
              <td className="rowBtns">
                <button onClick={() => onRestore?.(r)}>Restore</button>
                <button className="danger" onClick={() => onPermanentDelete?.(r)}>Permanent Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

'''
code = code.replace("\nfunction TableCheckouts", "\n" + components + "\nfunction TableCheckouts")

out = Path("/mnt/data/App.jsx")
out.write_text(code, encoding="utf-8")
print("created", out)
print("length", len(code))
